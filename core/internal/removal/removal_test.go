package removal

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/router"
)

const entryID = "qwen"

// fakeRouter reports states, and once a model was unloaded reports it stopped after stopAfter more Snapshot calls
// (never, when stopAfter is negative).
type fakeRouter struct {
	mu        sync.Mutex
	states    []router.ModelState
	stopAfter int
	unloaded  []string
	polls     int
	notified  int
}

func (f *fakeRouter) Snapshot() []router.ModelState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.unloaded) > 0 {
		f.polls++
		if f.stopAfter >= 0 && f.polls > f.stopAfter {
			return nil
		}
	}
	return f.states
}

func (f *fakeRouter) Unload(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unloaded = append(f.unloaded, id)
	return true
}

func (f *fakeRouter) Notify() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notified++
}

type fakeCatalog struct {
	folder  string
	err     error
	entered chan struct{} // receives on every Folder call when set
}

func (f *fakeCatalog) Folder(id string) (string, error) {
	if f.entered != nil {
		f.entered <- struct{}{}
	}
	if f.err != nil {
		return "", f.err
	}
	if id != entryID {
		return "", catalog.ErrUnknown
	}
	return f.folder, nil
}

func (f *fakeCatalog) View() catalog.View {
	return catalog.View{Entries: []catalog.Item{
		{Entry: catalog.Entry{ID: "other", Files: []catalog.File{{Name: "other.gguf"}}}},
		{Entry: catalog.Entry{ID: entryID, Files: []catalog.File{{Name: "qwen-q4.GGUF"}}}},
	}}
}

type fakeDownloads struct {
	items     []downloads.DownloadItem
	cancelErr error
	cancelled []string
}

func (f *fakeDownloads) Items() []downloads.DownloadItem { return f.items }

func (f *fakeDownloads) Cancel(id string) error {
	f.cancelled = append(f.cancelled, id)
	return f.cancelErr
}

type fakeTrash struct {
	mu    sync.Mutex
	fails int // the first fails calls fail
	paths []string
}

func (f *fakeTrash) move(path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paths = append(f.paths, path)
	if len(f.paths) <= f.fails {
		return errors.New("Operation was aborted")
	}
	return nil
}

type fixture struct {
	models  string
	folder  string
	router  *fakeRouter
	catalog *fakeCatalog
	dl      *fakeDownloads
	trash   *fakeTrash
	log     *bytes.Buffer
	cfg     Config
}

// newFixture has a models folder holding the entry's folder, nothing running and nothing queued.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	models := t.TempDir()
	folder := filepath.Join(models, entryID)
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fixture{
		models:  models,
		folder:  folder,
		router:  &fakeRouter{},
		catalog: &fakeCatalog{folder: folder},
		dl:      &fakeDownloads{},
		trash:   &fakeTrash{},
		log:     &bytes.Buffer{},
	}
	f.cfg = Config{
		Router:     f.router,
		Catalog:    f.catalog,
		Downloads:  f.dl,
		ModelsDir:  func() string { return f.models },
		Trash:      f.trash.move,
		Logger:     slog.New(slog.NewTextHandler(f.log, nil)),
		Poll:       time.Millisecond,
		UnloadWait: 50 * time.Millisecond,
		Retry:      time.Millisecond,
	}
	return f
}

func (f *fixture) remove(id string) error { return New(f.cfg).Remove(context.Background(), id) }

func (f *fixture) warnings() int { return strings.Count(f.log.String(), "level=WARN") }

func TestRemoveInstalled(t *testing.T) {
	f := newFixture(t)
	if err := f.remove(entryID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(f.trash.paths) != 1 || f.trash.paths[0] != f.folder {
		t.Errorf("trashed %v, want [%s]", f.trash.paths, f.folder)
	}
	if f.router.notified != 1 {
		t.Errorf("Notify called %d times, want 1", f.router.notified)
	}
	if len(f.dl.cancelled) != 0 {
		t.Errorf("cancelled %v, want nothing", f.dl.cancelled)
	}
}

func TestRemoveUnknownEntry(t *testing.T) {
	err := newFixture(t).remove("nope")
	if !errors.Is(err, ErrUnknownEntry) {
		t.Fatalf("err = %v, want ErrUnknownEntry", err)
	}
	if errors.Is(err, catalog.ErrUnknown) {
		t.Error("err wraps catalog.ErrUnknown")
	}
}

func TestRemoveNoModelsFolder(t *testing.T) {
	f := newFixture(t)
	f.catalog.err = catalog.ErrNoFolder
	if err := f.remove(entryID); !errors.Is(err, catalog.ErrNoFolder) {
		t.Fatalf("err = %v, want catalog.ErrNoFolder", err)
	}
}

func TestRemoveOutsideModelsFolder(t *testing.T) {
	cases := []struct {
		name   string
		folder func(models string) string
	}{
		{"sibling", func(m string) string { return filepath.Join(filepath.Dir(m), "sibling") }},
		{"the folder itself", func(m string) string { return m }},
		{"dot dot", func(m string) string {
			return m + string(filepath.Separator) + ".." + string(filepath.Separator) + "other"
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			f.catalog.folder = c.folder(f.models)
			if err := os.MkdirAll(f.catalog.folder, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := f.remove(entryID); !errors.Is(err, ErrOutside) {
				t.Fatalf("err = %v, want ErrOutside", err)
			}
			if len(f.trash.paths) != 0 {
				t.Errorf("trashed %v", f.trash.paths)
			}
		})
	}
}

func TestRemoveInsideDespiteCase(t *testing.T) {
	f := newFixture(t)
	f.cfg.ModelsDir = func() string { return strings.ToUpper(f.models) }
	if err := f.remove(entryID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(f.trash.paths) != 1 {
		t.Errorf("trashed %v, want one folder", f.trash.paths)
	}
}

func TestRemoveNotInstalled(t *testing.T) {
	f := newFixture(t)
	if err := os.Remove(f.folder); err != nil {
		t.Fatal(err)
	}
	if err := f.remove(entryID); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v, want ErrNotInstalled", err)
	}
}

func TestRemoveWaitsForUnload(t *testing.T) {
	f := newFixture(t)
	f.router.states = []router.ModelState{
		{ID: "qwen-q4", State: router.StateReady},
		{ID: "other", State: router.StateReady},
	}
	f.router.stopAfter = 3
	if err := f.remove(entryID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(f.router.unloaded) != 1 || f.router.unloaded[0] != "qwen-q4" {
		t.Errorf("unloaded %v, want [qwen-q4]", f.router.unloaded)
	}
	if f.router.polls <= f.router.stopAfter {
		t.Errorf("polled %d times, want more than %d", f.router.polls, f.router.stopAfter)
	}
	if len(f.trash.paths) != 1 {
		t.Errorf("trashed %v, want one folder", f.trash.paths)
	}
}

func TestRemoveUnloadTimeout(t *testing.T) {
	f := newFixture(t)
	f.router.states = []router.ModelState{{ID: "qwen-q4", State: router.StateLoading}}
	f.router.stopAfter = -1
	if err := f.remove(entryID); !errors.Is(err, ErrUnloadTimeout) {
		t.Fatalf("err = %v, want ErrUnloadTimeout", err)
	}
	if len(f.trash.paths) != 0 {
		t.Errorf("trashed %v", f.trash.paths)
	}
}

func TestRemoveSkipsModelInError(t *testing.T) {
	f := newFixture(t)
	f.router.states = []router.ModelState{{ID: "qwen-q4", State: router.StateError, Error: "boom"}}
	f.router.stopAfter = -1
	if err := f.remove(entryID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(f.router.unloaded) != 0 {
		t.Errorf("unloaded %v, want nothing", f.router.unloaded)
	}
}

func TestRemoveRetriesTrash(t *testing.T) {
	f := newFixture(t)
	f.trash.fails = 2
	if err := f.remove(entryID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(f.trash.paths) != 3 {
		t.Errorf("Trash called %d times, want 3", len(f.trash.paths))
	}
	if n := f.warnings(); n != 2 {
		t.Errorf("%d warnings logged, want 2:\n%s", n, f.log)
	}
}

func TestRemoveTrashFails(t *testing.T) {
	f := newFixture(t)
	f.trash.fails = 3
	if err := f.remove(entryID); !errors.Is(err, ErrTrashFailed) {
		t.Fatalf("err = %v, want ErrTrashFailed", err)
	}
	if f.router.notified != 0 {
		t.Error("Notify called after a failed move")
	}
}

func TestRemoveDismissesFinishedDownload(t *testing.T) {
	cases := []struct {
		name      string
		cancelErr error
		warnings  int
	}{
		{"cancel works", nil, 0},
		{"cancel fails", errors.New("gone"), 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			f.dl.items = []downloads.DownloadItem{
				{ID: "other", State: downloads.Done},
				{ID: entryID, State: downloads.Done},
			}
			f.dl.cancelErr = c.cancelErr
			if err := f.remove(entryID); err != nil {
				t.Fatalf("Remove: %v", err)
			}
			if len(f.dl.cancelled) != 1 || f.dl.cancelled[0] != entryID {
				t.Errorf("cancelled %v, want [%s]", f.dl.cancelled, entryID)
			}
			if n := f.warnings(); n != c.warnings {
				t.Errorf("%d warnings logged, want %d", n, c.warnings)
			}
		})
	}
}

func TestRemoveRunsOneAtATime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t)
		release := make(chan struct{})
		inTrash := make(chan struct{})
		f.cfg.Trash = func(path string) error {
			inTrash <- struct{}{}
			<-release
			return f.trash.move(path)
		}
		f.catalog.entered = make(chan struct{}, 2)
		r := New(f.cfg)

		errs := make(chan error, 2)
		go func() { errs <- r.Remove(context.Background(), entryID) }()
		<-inTrash
		go func() { errs <- r.Remove(context.Background(), entryID) }()
		synctest.Wait() // every goroutine is blocked: the second call waits for its turn
		if n := len(f.catalog.entered); n != 1 {
			t.Fatalf("Folder called %d times while the first removal was moving, want 1", n)
		}

		close(release)
		if err := <-errs; err != nil {
			t.Fatalf("first Remove: %v", err)
		}
		// The fake moves nothing, so the folder is still there and the second removal reaches Trash too.
		<-inTrash
		if err := <-errs; err != nil {
			t.Fatalf("second Remove: %v", err)
		}
		if n := len(f.catalog.entered); n != 2 {
			t.Errorf("Folder called %d times, want 2", n)
		}
	})
}
