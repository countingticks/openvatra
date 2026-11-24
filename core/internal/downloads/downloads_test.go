package downloads

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/download"
)

var payload = []byte(strings.Repeat("openvatra-queue-bytes-", 2000))

func entry(id string, srvURL string) catalog.Entry {
	s := sha256.Sum256(payload)
	return catalog.Entry{
		ID: id, Repo: "o/" + id, Revision: strings.Repeat("a", 40), BaseURL: srvURL,
		Files: []catalog.File{{Name: id + ".gguf", SizeBytes: int64(len(payload)), SHA256: hex.EncodeToString(s[:])}},
	}
}

// fixture serves payload for every model; gate (if set) holds each response until it is closed. With stall set, a
// first request (no Range) gets stallAt bytes and then hangs until the client goes away.
type fixture struct {
	m       *Manager
	entries []catalog.Entry // the catalog source's entries: a test may change their files
	dir     string
	srv     *httptest.Server
	done    atomic.Int32 // OnFinish calls
	ready   atomic.Int32 // OnEngineReady calls
	gate    chan struct{}
	stall   atomic.Bool
}

// stallAt is how many bytes a stalled response sends before it hangs.
const stallAt = 1000

// serve answers with body; with stall, a request without Range gets stallAt bytes and then hangs until the client
// goes away, so a download is caught mid-file with a .part on disk. A Range request (a resume) is answered in full.
func serve(w http.ResponseWriter, r *http.Request, body []byte, stall bool) {
	if !stall || r.Header.Get("Range") != "" {
		http.ServeContent(w, r, path.Base(r.URL.Path), time.Time{}, strings.NewReader(string(body)))
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body[:stallAt])
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

// testDownloader lets the local test server through.
func testDownloader() *download.Downloader {
	return &download.Downloader{
		Client: &http.Client{}, AllowHost: func(string) bool { return true }, AllowLocalHTTP: true,
		Backoff: []time.Duration{time.Millisecond, time.Millisecond},
	}
}

func newFixture(t *testing.T, gated bool, ids ...string) *fixture {
	t.Helper()
	f := &fixture{dir: t.TempDir()}
	if gated {
		f.gate = make(chan struct{})
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.gate != nil {
			select {
			case <-f.gate:
			case <-r.Context().Done():
				return
			}
		}
		serve(w, r, payload, f.stall.Load())
	}))
	t.Cleanup(f.srv.Close)
	for _, id := range ids {
		f.entries = append(f.entries, entry(id, f.srv.URL))
	}
	f.m = New(Config{
		Downloader:    testDownloader(),
		Sources:       []Source{CatalogSource(f.entries)},
		ModelsDir:     func() string { return f.dir },
		DiskFree:      func(string) (uint64, error) { return 1 << 40, nil },
		OnFinish:      func() { f.done.Add(1) },
		OnEngineReady: func() { f.ready.Add(1) },
	})
	t.Cleanup(f.m.Close)
	return f
}

func (f *fixture) state(id string) State {
	for _, it := range f.m.Items() {
		if it.ID == id {
			return it.State
		}
	}
	return ""
}

func (f *fixture) waitFor(t *testing.T, id string, want State) {
	t.Helper()
	waitItem(t, f.m, id, func(it DownloadItem) bool { return it.State == want })
}

// item is id's entry in m.Items(); a zero item when it is not listed.
func item(m *Manager, id string) DownloadItem {
	for _, it := range m.Items() {
		if it.ID == id {
			return it
		}
	}
	return DownloadItem{}
}

// waitItem polls m.Items() until id's item satisfies ok, and returns it.
func waitItem(t *testing.T, m *Manager, id string, ok func(DownloadItem) bool) DownloadItem {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		it := item(m, id)
		if ok(it) {
			return it
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never got there: %+v", id, it)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stalled starts id on a stalling server and waits until its .part holds stallAt bytes.
func (f *fixture) stalled(t *testing.T, id string) {
	t.Helper()
	f.stall.Store(true)
	if err := f.m.Start(id); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, id, func(it DownloadItem) bool { return it.State == Downloading && it.Bytes == stallAt })
}

func TestStartDownloadsAndFinishes(t *testing.T) {
	f := newFixture(t, false, "a")
	if err := f.m.Start("a"); err != nil {
		t.Fatal(err)
	}
	f.waitFor(t, "a", Done)
	if got, err := os.ReadFile(filepath.Join(f.dir, "a", "a.gguf")); err != nil || string(got) != string(payload) {
		t.Fatalf("file wrong: %v", err)
	}
	if f.done.Load() != 1 {
		t.Fatalf("OnFinish ran %d times", f.done.Load())
	}
	if err := f.m.Start("a"); !errors.Is(err, ErrInstalled) {
		t.Fatalf("second start = %v, want ErrInstalled", err)
	}
}

// Nothing makes the models folder beforehand: the default one does not exist until the first download.
func TestStartCreatesTheModelsFolder(t *testing.T) {
	f := newFixture(t, false, "a")
	models := f.dir
	f.dir = filepath.Join(models, "not", "yet")
	if err := f.m.Start("a"); err != nil {
		t.Fatal(err)
	}
	f.waitFor(t, "a", Done)
	if got, err := os.ReadFile(filepath.Join(f.dir, "a", "a.gguf")); err != nil || string(got) != string(payload) {
		t.Fatalf("file wrong: %v", err)
	}
}

func TestOnlyOneAtATime(t *testing.T) {
	f := newFixture(t, true, "a", "b")
	_ = f.m.Start("a")
	_ = f.m.Start("b")
	f.waitFor(t, "a", Downloading)
	if got := f.state("b"); got != Queued {
		t.Fatalf("b is %q while a downloads, want queued", got)
	}
	close(f.gate)
	f.waitFor(t, "b", Done)
}

func TestCancelRunningDeletesPartialFile(t *testing.T) {
	f := newFixture(t, true, "a")
	defer close(f.gate)
	_ = f.m.Start("a")
	f.waitFor(t, "a", Downloading)
	if err := f.m.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	f.waitFor(t, "a", "")
	time.Sleep(20 * time.Millisecond) // the worker removes the files just after the job disappears
	if _, err := os.Stat(filepath.Join(f.dir, "a")); !os.IsNotExist(err) {
		t.Fatalf("the model's folder is still there (%v)", err)
	}
}

func TestCancelQueued(t *testing.T) {
	f := newFixture(t, true, "a", "b")
	_ = f.m.Start("a")
	_ = f.m.Start("b")
	f.waitFor(t, "a", Downloading)
	if err := f.m.Cancel("b"); err != nil {
		t.Fatal(err)
	}
	if got := f.state("b"); got != "" {
		t.Fatalf("b is %q after cancel", got)
	}
	close(f.gate)
	f.waitFor(t, "a", Done)
	if got := f.state("b"); got != "" {
		t.Fatalf("cancelled b came back as %q", got)
	}
}

func TestLeftoverPartShowsPausedAndResumes(t *testing.T) {
	f := newFixture(t, false, "a")
	dir := filepath.Join(f.dir, "a")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "a.gguf.part"), payload[:1000], 0o644)

	items := f.m.Items()
	if len(items) != 1 || items[0].State != Paused || items[0].Bytes != 1000 || items[0].Total != int64(len(payload)) {
		t.Fatalf("items = %+v", items)
	}
	if err := f.m.Resume("a"); err != nil {
		t.Fatal(err)
	}
	f.waitFor(t, "a", Done)
}

func TestEveryItemIsNamedAfterItsFirstFile(t *testing.T) {
	f := newFixture(t, true, "a", "b")
	defer close(f.gate)
	dir := filepath.Join(f.dir, "b") // b was left half done by an earlier run
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "b.gguf.part"), payload[:1000], 0o644)
	_ = f.m.Start("a")
	f.waitFor(t, "a", Downloading)
	got := map[string]string{}
	for _, it := range f.m.Items() {
		got[it.ID] = it.Name
	}
	if got["a"] != "a.gguf" || got["b"] != "b.gguf" || len(got) != 2 {
		t.Fatalf("names = %v", got)
	}
}

func TestCancelPausedLeftoverDeletesIt(t *testing.T) {
	f := newFixture(t, false, "a")
	dir := filepath.Join(f.dir, "a")
	_ = os.MkdirAll(dir, 0o755)
	part := filepath.Join(dir, "a.gguf.part")
	_ = os.WriteFile(part, payload[:10], 0o644)
	if err := f.m.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the model's folder is still there (%v)", err)
	}
	if err := f.m.Cancel("a"); !errors.Is(err, ErrNoDownload) {
		t.Fatalf("second cancel = %v, want ErrNoDownload", err)
	}
}

func TestCancelDeletesFinishedFilesOfAnUnfinishedModel(t *testing.T) {
	f := newFixture(t, false, "a")
	f.entries[0].Files = append(f.entries[0].Files, catalog.File{Name: "mmproj.gguf", SizeBytes: 50})
	dir := filepath.Join(f.dir, "a")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "a.gguf"), payload, 0o644) // first file done
	_ = os.WriteFile(filepath.Join(dir, "mmproj.gguf.part"), payload[:10], 0o644)
	if err := f.m.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the model's folder is still there (%v)", err)
	}
}

func TestCancelKeepsAFolderWithOtherFiles(t *testing.T) {
	f := newFixture(t, false, "a")
	dir := filepath.Join(f.dir, "a")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "a.gguf.part"), payload[:10], 0o644)
	mine := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(mine, []byte("mine"), 0o644)
	if err := f.m.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mine); err != nil {
		t.Fatalf("a file that is not the download's was deleted: %v", err)
	}
}

func TestDismissingAFinishedDownloadKeepsTheModel(t *testing.T) {
	f := newFixture(t, false, "a")
	_ = f.m.Start("a")
	f.waitFor(t, "a", Done)
	if err := f.m.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "a", "a.gguf")); err != nil {
		t.Fatalf("dismissing deleted the installed model: %v", err)
	}
}

func TestNoConnectionPauses(t *testing.T) {
	f := newFixture(t, false, "a")
	f.srv.Close() // nothing listens any more
	_ = f.m.Start("a")
	f.waitFor(t, "a", Paused)
	if it := f.m.Items()[0]; it.Error != "No connection" {
		t.Fatalf("error = %q", it.Error)
	}
}

func TestDamagedFileFails(t *testing.T) {
	f := newFixture(t, false, "a")
	f.entries[0].Files[0].SHA256 = strings.Repeat("0", 64)
	_ = f.m.Start("a")
	f.waitFor(t, "a", Failed)
	if it := f.m.Items()[0]; !strings.Contains(it.Error, "damaged") {
		t.Fatalf("error = %q", it.Error)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "a", "a.gguf")); err == nil {
		t.Fatal("a damaged file got its final name")
	}
}

func TestRefusals(t *testing.T) {
	f := newFixture(t, false, "a")
	if err := f.m.Start("nope"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("unknown = %v", err)
	}
	if err := f.m.Resume("a"); !errors.Is(err, ErrNotResumable) {
		t.Fatalf("resume of nothing = %v", err)
	}
	f.m.cfg.DiskFree = func(string) (uint64, error) { return 1 << 20, nil }
	if err := f.m.Start("a"); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("no space = %v", err)
	}
	f.m.cfg.ModelsDir = func() string { return "" }
	if err := f.m.Start("a"); !errors.Is(err, ErrNoFolder) {
		t.Fatalf("no folder = %v", err)
	}
}

func TestSubscribersAreToldAboutChanges(t *testing.T) {
	f := newFixture(t, false, "a")
	ch, cancel := f.m.Subscribe()
	defer cancel()
	_ = f.m.Start("a")
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("no signal after Start")
	}
}

func TestPauseMidFileKeepsThePartAndResumeFinishes(t *testing.T) {
	f := newFixture(t, false, "a")
	f.stalled(t, "a")
	if err := f.m.Pause("a"); err != nil {
		t.Fatal(err)
	}
	it := waitItem(t, f.m, "a", func(it DownloadItem) bool { return it.State == Paused })
	if it.Error != "" || it.Speed != 0 || it.Bytes != stallAt {
		t.Fatalf("paused item = %+v", it)
	}
	if info, err := os.Stat(filepath.Join(f.dir, "a", "a.gguf.part")); err != nil || info.Size() != stallAt {
		t.Fatalf("part file: %v", err)
	}

	if err := f.m.Resume("a"); err != nil {
		t.Fatal(err)
	}
	f.waitFor(t, "a", Done)
	got, err := os.ReadFile(filepath.Join(f.dir, "a", "a.gguf"))
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(got); hex.EncodeToString(sum[:]) != f.entries[0].Files[0].SHA256 {
		t.Fatal("the resumed file has the wrong sha256")
	}
}

func TestPauseThenCancelDeletesThePart(t *testing.T) {
	f := newFixture(t, false, "a")
	f.stalled(t, "a")
	if err := f.m.Pause("a"); err != nil {
		t.Fatal(err)
	}
	f.waitFor(t, "a", Paused)
	if err := f.m.Cancel("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "a")); !os.IsNotExist(err) {
		t.Fatalf("the model's folder is still there (%v)", err)
	}
}

func TestPauseQueuedTakesItOutOfTheQueue(t *testing.T) {
	f := newFixture(t, true, "a", "b")
	_ = f.m.Start("a")
	_ = f.m.Start("b")
	f.waitFor(t, "a", Downloading)
	if err := f.m.Pause("b"); err != nil {
		t.Fatal(err)
	}
	if it := item(f.m, "b"); it.State != Paused || it.Error != "" {
		t.Fatalf("b = %+v, want paused", it)
	}
	close(f.gate)
	f.waitFor(t, "a", Done)
	if got := f.state("b"); got != Paused {
		t.Fatalf("b is %q after a finished, want paused", got)
	}
}

func TestPauseRefusesWhatIsNotRunning(t *testing.T) {
	f := newFixture(t, false, "a", "b")
	if err := f.m.Pause("nope"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("unknown = %v", err)
	}
	dir := filepath.Join(f.dir, "b") // b is paused, left by an earlier run
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "b.gguf.part"), payload[:10], 0o644)
	if err := f.m.Pause("b"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("paused = %v", err)
	}
	_ = f.m.Start("a")
	f.waitFor(t, "a", Done)
	if err := f.m.Pause("a"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("done = %v", err)
	}
}
