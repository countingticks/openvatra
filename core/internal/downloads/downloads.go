// Package downloads is the queue in front of package download: it runs catalog downloads (and the optional CUDA
// engine) one at a time, lets the UI cancel or resume them, and reports progress. Package download moves the bytes;
// this one decides which, and when.
package downloads

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/download"
	"github.com/countingticks/openvatra/core/internal/hw"
)

// State is where a download stands, as the UI receives it.
type State string

const (
	Queued      State = "queued"
	Downloading State = "downloading"
	Verifying   State = "verifying"
	Paused      State = "paused"
	Failed      State = "error"
	Done        State = "done"
)

// Item is one download as the "downloads" event shows it. ID is the catalog id.
type Item struct {
	ID    string `json:"id"`
	State State  `json:"state"`
	Bytes int64  `json:"bytes"`
	Total int64  `json:"total"`
	Speed int64  `json:"speed"` // bytes per second over the last half second or so
	Error string `json:"error,omitempty"`
}

// Errors the API maps to answers.
var (
	ErrUnknown      = errors.New("not a catalog model or engine")
	ErrNoFolder     = errors.New("no models folder is set")
	ErrInstalled    = errors.New("already installed")
	ErrNoSpace      = errors.New("not enough disk space")
	ErrNotResumable = errors.New("only a paused or failed download can be resumed")
	ErrNoDownload   = errors.New("no such download")
)

// diskSpare mirrors the catalog's rule: 2 GB stay free after a download.
const diskSpare = 2 << 30

// speedWindow is how often the speed is recalculated; shorter would make the number jump.
const speedWindow = 500 * time.Millisecond

// Config is everything a Manager needs from outside.
type Config struct {
	Downloader *download.Downloader
	Entries    []catalog.Entry
	ModelsDir  func() string // read on every use: the user can change the folder while core runs
	// DiskFree is a seam for tests; nil means the real drive.
	DiskFree func(dir string) (uint64, error)
	// OnFinish runs after a model finished, so the caller can rescan the folder and tell the UI.
	OnFinish func()
	// Engine is the optional CUDA build; nil when core was started without a manifest.
	Engine *Engine
}

// target is what one queue entry downloads: a catalog model or the engine. Both are "some files into a folder",
// which is why one worker and one set of rules serve both.
type target struct {
	id        string
	files     []catalog.File
	folder    string                      // "" while it is unknown (no models folder yet)
	url       func(f catalog.File) string // where each file comes from
	allowHost func(string) bool           // nil = the downloader's own list
	installed func() bool                 // nil = "every file is in folder"
	extra     int64                       // disk needed beyond the files themselves (unpacking)
	finish    func(ctx context.Context, folder string) error
}

type job struct {
	target    target
	state     State
	done      int64
	total     int64
	speed     int64
	err       string
	cancel    context.CancelFunc // stops the running fetch
	cancelled bool               // the user asked to cancel: delete the partial files when the fetch has stopped
	lastAt    time.Time
	lastBytes int64
}

// Manager owns the queue. One worker goroutine takes jobs in order, so only one file downloads at a time.
type Manager struct {
	cfg Config

	mu    sync.Mutex
	jobs  map[string]*job
	queue []string
	subs  map[chan struct{}]struct{}

	wake chan struct{}
	ctx  context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup
}

// New starts the worker. Close stops it.
func New(cfg Config) *Manager {
	if cfg.DiskFree == nil {
		cfg.DiskFree = hw.DiskFree
	}
	ctx, stop := context.WithCancel(context.Background())
	m := &Manager{cfg: cfg, jobs: map[string]*job{}, subs: map[chan struct{}]struct{}{}, wake: make(chan struct{}, 1), ctx: ctx, stop: stop}
	m.wg.Add(1)
	go func() { defer m.wg.Done(); m.loop() }()
	return m
}

// Close cancels the running download (its partial file stays, so the next start shows it as paused) and waits.
func (m *Manager) Close() {
	m.stop()
	m.wg.Wait()
}

// Subscribe returns a channel that gets a signal after any change, like the router's.
func (m *Manager) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	m.mu.Lock()
	m.subs[ch] = struct{}{}
	m.mu.Unlock()
	return ch, func() {
		m.mu.Lock()
		delete(m.subs, ch)
		m.mu.Unlock()
	}
}

// notify never blocks: a subscriber that hasn't read its last signal yet will see the newest state anyway.
func (m *Manager) notify() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for ch := range m.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// Items lists every download worth showing, in catalog order. A model with no job but a leftover .part file from an
// earlier run shows as paused: that is how a download survives closing the app, with no state file of our own.
func (m *Manager) Items() []Item {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Item{}
	for _, t := range m.targets() {
		if j := m.jobs[t.id]; j != nil {
			out = append(out, Item{ID: t.id, State: j.state, Bytes: j.done, Total: j.total, Speed: j.speed, Error: j.err})
			continue
		}
		if t.folder == "" {
			continue
		}
		if have := partBytes(t.folder, t.files); have > 0 {
			out = append(out, Item{ID: t.id, State: Paused, Bytes: have, Total: totalSize(t.files)})
		}
	}
	return out
}

// Start queues a model. Asking again for one that is already queued or running changes nothing.
func (m *Manager) Start(id string) error { return m.enqueue(id, false) }

// Resume queues a paused or failed download again. The partial file is continued where it stopped.
func (m *Manager) Resume(id string) error { return m.enqueue(id, true) }

// StartEngine queues the CUDA engine; ErrUnknown when core has no manifest for it.
func (m *Manager) StartEngine() error { return m.enqueue(EngineID, false) }

func (m *Manager) enqueue(id string, mustBeStopped bool) error {
	m.mu.Lock()
	t, ok := m.target(id)
	if !ok {
		m.mu.Unlock()
		return ErrUnknown
	}
	if t.folder == "" {
		m.mu.Unlock()
		return ErrNoFolder
	}
	if t.installed != nil && t.installed() {
		m.mu.Unlock()
		return ErrInstalled
	}
	folder := t.folder
	stopped := false // paused or failed, with or without a job in memory
	if j := m.jobs[id]; j != nil {
		switch j.state {
		case Queued, Downloading, Verifying:
			m.mu.Unlock()
			if mustBeStopped {
				return ErrNotResumable
			}
			return nil
		case Paused, Failed:
			stopped = true
		}
	} else if partBytes(folder, t.files) > 0 {
		stopped = true
	}
	if mustBeStopped && !stopped {
		m.mu.Unlock()
		return ErrNotResumable
	}
	missing := missingBytes(folder, t.files)
	if missing == 0 && t.installed == nil {
		m.mu.Unlock()
		return ErrInstalled
	}
	m.mu.Unlock()

	// The folder doesn't exist before the first download; the drive check needs a folder that does.
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	if free, err := m.cfg.DiskFree(folder); err == nil && uint64(missing+t.extra)+diskSpare > free {
		return ErrNoSpace // an unreadable drive never blocks a download, as in the catalog
	}

	m.mu.Lock()
	if j := m.jobs[id]; j != nil && (j.state == Queued || j.state == Downloading || j.state == Verifying) {
		m.mu.Unlock()
		return nil // a second request got in while the disk was being checked
	}
	m.jobs[id] = &job{target: t, state: Queued, done: totalSize(t.files) - missing, total: totalSize(t.files)}
	m.queue = append(m.queue, id)
	m.mu.Unlock()
	m.notify()
	select {
	case m.wake <- struct{}{}:
	default:
	}
	return nil
}

// Cancel stops a download and deletes what it wrote so far, whatever state it is in. A finished one is just dismissed.
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	t, ok := m.target(id)
	if !ok {
		m.mu.Unlock()
		return ErrUnknown
	}
	folder := t.folder
	j := m.jobs[id]
	finished := j != nil && j.state == Done // installed: dismissing it must not touch the files
	switch {
	case j != nil && (j.state == Downloading || j.state == Verifying):
		// The worker deletes the files once the fetch has really stopped; deleting an open file would fail on Windows.
		j.cancelled = true
		j.cancel()
		m.mu.Unlock()
		return nil
	case j != nil:
		m.dequeue(id)
		delete(m.jobs, id)
	case folder == "" || partBytes(folder, t.files) == 0:
		m.mu.Unlock()
		return ErrNoDownload
	}
	m.mu.Unlock()
	if folder != "" && !finished {
		discard(folder, t.files)
	}
	m.notify()
	return nil
}

func (m *Manager) dequeue(id string) {
	for i, q := range m.queue {
		if q == id {
			m.queue = append(m.queue[:i], m.queue[i+1:]...)
			return
		}
	}
}

func (m *Manager) loop() {
	for {
		id, ok := m.next()
		if !ok {
			return
		}
		m.run(id)
	}
}

// next blocks until a job is queued. false means Close was called.
func (m *Manager) next() (string, bool) {
	for {
		m.mu.Lock()
		if len(m.queue) > 0 {
			id := m.queue[0]
			m.queue = m.queue[1:]
			m.mu.Unlock()
			return id, true
		}
		m.mu.Unlock()
		select {
		case <-m.wake:
		case <-m.ctx.Done():
			return "", false
		}
	}
}

func (m *Manager) run(id string) {
	ctx, cancel := context.WithCancel(m.ctx)
	defer cancel()

	m.mu.Lock()
	j := m.jobs[id]
	if j == nil {
		m.mu.Unlock()
		return
	}
	// Looked up again: the user may have changed the models folder while this job waited.
	t, _ := m.target(id)
	if t.folder == "" {
		m.mu.Unlock()
		return
	}
	j.target = t
	j.state, j.err, j.cancel = Downloading, "", cancel
	j.lastAt, j.lastBytes = time.Now(), j.done
	m.mu.Unlock()
	m.notify()

	folder := t.folder
	err := m.fetchAll(ctx, j, t)
	if err == nil && t.finish != nil {
		err = t.finish(ctx, folder)
	}

	m.mu.Lock()
	j.cancel = nil
	switch {
	case err == nil:
		j.state, j.done, j.speed = Done, j.total, 0
	case j.cancelled:
		delete(m.jobs, id)
	case m.ctx.Err() != nil:
		j.state, j.speed = Paused, 0 // core is closing; the .part files stay for the next start
	case errors.Is(err, download.ErrPaused):
		j.state, j.speed, j.err = Paused, 0, "No connection"
	case errors.Is(err, download.ErrDamaged):
		j.state, j.speed, j.err = Failed, 0, "The download was damaged, try again"
	default:
		j.state, j.speed, j.err = Failed, 0, "The download failed"
	}
	cancelled := j.cancelled && err != nil
	m.mu.Unlock()

	if cancelled {
		discard(folder, t.files)
	}
	if err == nil && m.cfg.OnFinish != nil {
		m.cfg.OnFinish()
	}
	m.notify()
}

// fetchAll downloads the target's files in order, skipping the ones that are already complete.
func (m *Manager) fetchAll(ctx context.Context, j *job, t target) error {
	var before int64 // bytes of the files before this one
	for i, f := range t.files {
		dest := filepath.Join(t.folder, f.Name)
		if info, err := os.Stat(dest); err == nil && info.Mode().IsRegular() && info.Size() == f.SizeBytes {
			before += f.SizeBytes
			continue
		}
		last := i == len(t.files)-1
		req := download.Request{URL: t.url(f), Dest: dest, Size: f.SizeBytes, SHA256: f.SHA256, AllowHost: t.allowHost}
		err := m.cfg.Downloader.Fetch(ctx, req, func(p download.Progress) {
			m.progress(j, before+p.Done, last && p.Done == p.Total)
		})
		if err != nil {
			return err
		}
		before += f.SizeBytes
	}
	return nil
}

// target finds a queue entry by id. The caller holds m.mu or does not mind a stale ModelsDir.
func (m *Manager) target(id string) (target, bool) {
	for _, t := range m.targets() {
		if t.id == id {
			return t, true
		}
	}
	return target{}, false
}

// targets lists every catalog model, then the engine if core has one.
func (m *Manager) targets() []target {
	dir := m.cfg.ModelsDir()
	var out []target
	for _, e := range m.cfg.Entries {
		base := "https://huggingface.co"
		if e.BaseURL != "" {
			base = e.BaseURL
		}
		t := target{
			id:    e.ID,
			files: e.Files,
			url: func(f catalog.File) string {
				return fmt.Sprintf("%s/%s/resolve/%s/%s", base, e.Repo, e.Revision, f.Name)
			},
		}
		if dir != "" {
			t.folder = filepath.Join(dir, e.ID)
		}
		out = append(out, t)
	}
	if m.cfg.Engine != nil {
		out = append(out, m.cfg.Engine.target())
	}
	return out
}

func (m *Manager) progress(j *job, done int64, verifying bool) {
	m.mu.Lock()
	j.done = done
	if verifying {
		j.state = Verifying
	}
	if dt := time.Since(j.lastAt); dt >= speedWindow {
		j.speed = int64(float64(done-j.lastBytes) / dt.Seconds())
		j.lastAt, j.lastBytes = time.Now(), done
	}
	m.mu.Unlock()
	m.notify()
}

func totalSize(files []catalog.File) int64 {
	var n int64
	for _, f := range files {
		n += f.SizeBytes
	}
	return n
}

// partBytes adds up the size of the .part files in folder.
func partBytes(folder string, files []catalog.File) int64 {
	var n int64
	for _, f := range files {
		if info, err := os.Stat(filepath.Join(folder, f.Name+".part")); err == nil && info.Mode().IsRegular() {
			n += info.Size()
		}
	}
	return n
}

// missingBytes is what still has to be fetched: whole files not there yet, minus what their .part files already hold.
func missingBytes(folder string, files []catalog.File) int64 {
	var n int64
	for _, f := range files {
		if info, err := os.Stat(filepath.Join(folder, f.Name)); err == nil && info.Mode().IsRegular() && info.Size() == f.SizeBytes {
			continue
		}
		n += f.SizeBytes
		if info, err := os.Stat(filepath.Join(folder, f.Name+".part")); err == nil && info.Mode().IsRegular() && info.Size() < f.SizeBytes {
			n -= info.Size()
		}
	}
	return n
}

// discard deletes what a cancelled download wrote: every file of the entry, finished or partial (a model of several
// files can be cancelled after its first one completed), then the folder core made for it. os.Remove leaves a folder
// that is not empty, so anything else the user keeps there survives.
func discard(folder string, files []catalog.File) {
	for _, f := range files {
		_ = os.Remove(filepath.Join(folder, f.Name+".part"))
		_ = os.Remove(filepath.Join(folder, f.Name))
	}
	_ = os.Remove(folder)
}
