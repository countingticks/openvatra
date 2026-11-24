package downloads

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/hf"
	"github.com/countingticks/openvatra/core/internal/store"
)

// ErrNoPicks: there is no writable database to keep picks in (decision 30).
var ErrNoPicks = errors.New("Downloads from Hugging Face need the app's database, which couldn't be opened.")

// PickStore is where picks are kept; *store.Store in production.
type PickStore interface {
	HFPicks(ctx context.Context) ([]store.HFPick, error)
	SaveHFPick(ctx context.Context, p store.HFPick) error
	DeleteHFPick(ctx context.Context, id string) error
}

// Picks holds the saved picks in memory and yields their targets; it is a Source. Lock order: Manager.mu first, then
// mu. Store calls are made with neither held.
type Picks struct {
	st   PickStore
	base string
	log  *slog.Logger

	mu    sync.Mutex
	list  []store.HFPick // oldest first
	saved map[string]bool
}

// LoadPicks reads every row once. base "" = https://huggingface.co (else the --hf-base loopback address).
func LoadPicks(ctx context.Context, st PickStore, base string, logger *slog.Logger) (*Picks, error) {
	if base == "" {
		base = "https://huggingface.co"
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	rows, err := st.HFPicks(ctx)
	if err != nil {
		return nil, err
	}
	p := &Picks{st: st, base: strings.TrimRight(base, "/"), log: logger, saved: map[string]bool{}}
	for _, row := range rows {
		if err := validPick(row); err != nil {
			logger.Warn("skipping a saved Hugging Face download", "id", row.ID, "err", err)
			continue
		}
		p.list = append(p.list, row)
		p.saved[row.ID] = true
	}
	return p, nil
}

// The repo, quant and file names become folders, file names and URL segments: plain names only, so a bad row or
// answer can't reach outside the models folder.
var (
	repoPattern    = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	segmentPattern = regexp.MustCompile(`^[\w][\w.-]*$`)
	ggufPattern    = regexp.MustCompile(`(?i)^[\w][\w.-]*\.gguf$`)
	revPattern     = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

func validPick(p store.HFPick) error {
	if p.ID != "hf:"+p.Repo+":"+p.Quant {
		return errors.New("the id does not match the repo and quant")
	}
	if !repoPattern.MatchString(p.Repo) {
		return errors.New("bad repo")
	}
	for _, part := range strings.Split(p.Repo, "/") {
		if part == "." || part == ".." {
			return errors.New("bad repo")
		}
	}
	if !segmentPattern.MatchString(p.Quant) {
		return errors.New("bad quant")
	}
	if !revPattern.MatchString(p.Revision) {
		return errors.New("bad revision")
	}
	if len(p.Files) == 0 {
		return errors.New("no files")
	}
	seen := map[string]bool{}
	for _, f := range p.Files {
		name := strings.ToLower(f.Name)
		if !ggufPattern.MatchString(f.Name) || seen[name] {
			return fmt.Errorf("bad file name %q", f.Name)
		}
		seen[name] = true
		for _, seg := range strings.Split(f.Path, "/") {
			if !segmentPattern.MatchString(seg) {
				return fmt.Errorf("bad file path %q", f.Path)
			}
		}
		if f.SizeBytes <= 0 || !shaPattern.MatchString(f.SHA256) {
			return fmt.Errorf("bad size or sha256 for %q", f.Name)
		}
	}
	return nil
}

func (p *Picks) targets(dir string) []target {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]target, 0, len(p.list))
	for _, pick := range p.list {
		out = append(out, p.target(pick, dir))
	}
	return out
}

func (p *Picks) target(pick store.HFPick, dir string) target {
	files := make([]catalog.File, len(pick.Files))
	paths := make(map[string]string, len(pick.Files))
	for i, f := range pick.Files {
		files[i] = catalog.File{Name: f.Name, SizeBytes: f.SizeBytes, SHA256: f.SHA256}
		paths[f.Name] = f.Path
	}
	base, repo, rev := p.base, escapePath(pick.Repo), pick.Revision
	return target{
		id:     pick.ID,
		files:  files,
		folder: hf.Folder(dir, pick.Repo, pick.Quant),
		url: func(f catalog.File) string {
			return base + "/" + repo + "/resolve/" + rev + "/" + escapePath(paths[f.Name])
		},
	}
}

func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

// find returns the pick with id and whether it is saved.
func (p *Picks) find(id string) (store.HFPick, bool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, pick := range p.list {
		if pick.ID == id {
			return pick, true, p.saved[id]
		}
	}
	return store.HFPick{}, false, false
}

// add puts pick in memory, unsaved, unless its id is there already; true when it was added.
func (p *Picks) add(pick store.HFPick) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if slices.ContainsFunc(p.list, func(q store.HFPick) bool { return q.ID == pick.ID }) {
		return false
	}
	p.list = append(p.list, pick)
	return true
}

func (p *Picks) markSaved(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.saved[id] = true
}

// remove drops id from memory; false when it was not there.
func (p *Picks) remove(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := len(p.list)
	p.list = slices.DeleteFunc(p.list, func(q store.HFPick) bool { return q.ID == id })
	delete(p.saved, id)
	return len(p.list) != n
}

// StartPick queues pick, saving it the first time; an id already saved keeps its stored revision and files.
func (m *Manager) StartPick(ctx context.Context, pick store.HFPick) error {
	pk := m.cfg.Picks
	if pk == nil {
		return ErrNoPicks
	}
	if err := validPick(pick); err != nil {
		return fmt.Errorf("hugging face download %s: %w", pick.ID, err)
	}
	_, known, _ := pk.find(pick.ID)
	added := false
	if !known {
		pick.Created = time.Now()
		added = pk.add(pick)
	}
	if err := m.enqueue(pick.ID, false); err != nil {
		if added {
			pk.remove(pick.ID)
			// enqueue made the folder before it checked the drive; leave no empty folders behind
			m.removeEmptyPickFolders(hf.Folder(m.cfg.ModelsDir(), pick.Repo, pick.Quant))
		}
		return err
	}
	if !added {
		return nil
	}
	if err := pk.st.SaveHFPick(ctx, pick); err != nil {
		// The cancel drops it from memory once its files are gone (at once for a queued job).
		if m.Cancel(pick.ID) != nil {
			pk.remove(pick.ID)
		}
		return err
	}
	pk.markSaved(pick.ID)
	return nil
}

// PickOf is the pick whose folder holds path and whose files include its base name (case-insensitive).
func (m *Manager) PickOf(path string) (id, folder string, ok bool) {
	pk := m.cfg.Picks
	if pk == nil {
		return "", "", false
	}
	dir, name := filepath.Dir(filepath.Clean(path)), filepath.Base(path)
	modelsDir := m.cfg.ModelsDir()
	pk.mu.Lock()
	defer pk.mu.Unlock()
	for _, pick := range pk.list {
		f := hf.Folder(modelsDir, pick.Repo, pick.Quant)
		if f == "" || !strings.EqualFold(f, dir) {
			continue
		}
		for _, file := range pick.Files {
			if strings.EqualFold(file.Name, name) {
				return pick.ID, f, true
			}
		}
	}
	return "", "", false
}

// ForgetPick drops a pick's row and its finished job; ErrNoDownload when there is no such pick. No file is deleted.
func (m *Manager) ForgetPick(ctx context.Context, id string) error {
	pk := m.cfg.Picks
	if pk == nil {
		return ErrNoDownload
	}
	m.mu.Lock()
	if !pk.remove(id) {
		m.mu.Unlock()
		return ErrNoDownload
	}
	if j := m.jobs[id]; j != nil && j.state == Done {
		delete(m.jobs, id)
	}
	m.mu.Unlock()
	m.notify()
	return pk.st.DeleteHFPick(ctx, id)
}

// forgetCancelled runs after a cancel deleted a target's files: a pick also loses its empty folders, its place in
// memory and its row. A store failure is only logged; the files are gone either way.
func (m *Manager) forgetCancelled(id, folder string) {
	pk := m.cfg.Picks
	if pk == nil || !pk.remove(id) {
		return
	}
	m.removeEmptyPickFolders(folder)
	if err := pk.st.DeleteHFPick(context.Background(), id); err != nil {
		pk.log.Warn("could not forget a cancelled Hugging Face download", "id", id, "err", err)
	}
}

// removeEmptyPickFolders removes <quant>, <repo>, <owner> and hf in turn; os.Remove keeps any that is not empty.
func (m *Manager) removeEmptyPickFolders(folder string) {
	if folder == "" {
		return
	}
	for range 4 {
		_ = os.Remove(folder)
		folder = filepath.Dir(folder)
	}
}
