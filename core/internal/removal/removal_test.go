package removal

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/provider"
)

const entryID = "qwen"

// fakeRouter reports states, and once a model was unloaded reports it stopped after stopAfter more States calls
// (never, when stopAfter is negative).
type fakeRouter struct {
	mu        sync.Mutex
	states    []provider.ModelState
	stopAfter int
	unloaded  []string
	polls     int
	notified  int
}

func (f *fakeRouter) States() []provider.ModelState {
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

// EntryOf owns every file directly in the entry's folder.
func (f *fakeCatalog) EntryOf(path string) (string, bool) {
	if strings.EqualFold(filepath.Dir(path), f.folder) {
		return entryID, true
	}
	return "", false
}

type fakeDownloads struct {
	items     []downloads.DownloadItem
	cancelErr error
	cancelled []string
	// pickFolder, when set, is pickID's folder: PickOf owns every file directly in it.
	pickID, pickFolder string
	forgetErr          error
	forgotten          []string
}

func (f *fakeDownloads) Items() []downloads.DownloadItem { return f.items }

func (f *fakeDownloads) PickOf(path string) (string, string, bool) {
	if f.pickFolder != "" && strings.EqualFold(filepath.Dir(path), f.pickFolder) {
		return f.pickID, f.pickFolder, true
	}
	return "", "", false
}

func (f *fakeDownloads) ForgetPick(_ context.Context, id string) error {
	f.forgotten = append(f.forgotten, id)
	return f.forgetErr
}

func (f *fakeDownloads) Cancel(id string) error {
	f.cancelled = append(f.cancelled, id)
	return f.cancelErr
}

type fakeTrash struct {
	mu       sync.Mutex
	fails    int    // the first fails calls fail
	failPath string // every call for this path fails
	paths    []string
}

func (f *fakeTrash) move(path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paths = append(f.paths, path)
	if len(f.paths) <= f.fails || path == f.failPath {
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
	list    []models.Model // what List reports
	cfg     Config
}

// newFixture has a models folder holding the entry's folder, nothing running and nothing queued.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	folder := filepath.Join(dir, entryID)
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fixture{
		models:  dir,
		folder:  folder,
		router:  &fakeRouter{},
		catalog: &fakeCatalog{folder: folder},
		dl:      &fakeDownloads{},
		trash:   &fakeTrash{},
		log:     &bytes.Buffer{},
	}
	f.cfg = Config{
		Resident:   f.router,
		Catalog:    f.catalog,
		Downloads:  f.dl,
		ModelsDir:  func() string { return f.models },
		List:       func() ([]models.Model, error) { return f.list, nil },
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
	f.router.states = []provider.ModelState{
		{ID: "qwen-q4", State: provider.StateReady},
		{ID: "other", State: provider.StateReady},
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
	f.router.states = []provider.ModelState{{ID: "qwen-q4", State: provider.StateLoading}}
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
	f.router.states = []provider.ModelState{{ID: "qwen-q4", State: provider.StateError, Error: "boom"}}
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

// own writes the user's own files into the models folder and returns their paths.
func (f *fixture) own(t *testing.T, names ...string) []string {
	t.Helper()
	var paths []string
	for _, n := range names {
		p := filepath.Join(f.models, filepath.FromSlash(n))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	return paths
}

func (f *fixture) removeModel(id string) error {
	return New(f.cfg).RemoveModel(context.Background(), id)
}

func TestRemoveModelOwnFile(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "mine/llama.gguf")
	f.list = []models.Model{{ID: "llama", Path: p[0], Parts: p}}
	if err := f.removeModel("llama"); err != nil {
		t.Fatalf("RemoveModel: %v", err)
	}
	if !slices.Equal(f.trash.paths, p) {
		t.Errorf("trashed %v, want %v", f.trash.paths, p)
	}
	if f.router.notified != 1 {
		t.Errorf("Notify called %d times, want 1", f.router.notified)
	}
}

func TestRemoveModelMovesEveryPart(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "big-00001-of-00003.gguf", "big-00002-of-00003.gguf", "big-00003-of-00003.gguf")
	f.list = []models.Model{{ID: "big", Path: p[0], Parts: p}}
	if err := f.removeModel("big"); err != nil {
		t.Fatalf("RemoveModel: %v", err)
	}
	if !slices.Equal(f.trash.paths, p) {
		t.Errorf("trashed %v, want %v", f.trash.paths, p)
	}
}

func TestRemoveModelProjector(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "v/a.gguf", "v/b.gguf", "v/mmproj-a.gguf", "w/c.gguf", "w/mmproj-c.gguf")
	shared, own := p[2], p[4]
	f.list = []models.Model{
		{ID: "a", Path: p[0], Parts: p[0:1], MMProj: shared},
		{ID: "b", Path: p[1], Parts: p[1:2], MMProj: strings.ToUpper(shared)},
		{ID: "c", Path: p[3], Parts: p[3:4], MMProj: own},
	}
	if err := f.removeModel("c"); err != nil {
		t.Fatalf("RemoveModel c: %v", err)
	}
	if err := f.removeModel("a"); err != nil {
		t.Fatalf("RemoveModel a: %v", err)
	}
	if want := []string{p[3], own, p[0]}; !slices.Equal(f.trash.paths, want) {
		t.Errorf("trashed %v, want %v (a projector another model names stays)", f.trash.paths, want)
	}
}

func TestRemoveModelInCatalogFolder(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(f.folder, "qwen-q4.gguf")
	f.list = []models.Model{{ID: "qwen-q4", Path: p, Parts: []string{p}}}
	f.dl.items = []downloads.DownloadItem{{ID: entryID, State: downloads.Done}}
	if err := f.removeModel("qwen-q4"); err != nil {
		t.Fatalf("RemoveModel: %v", err)
	}
	if len(f.trash.paths) != 1 || f.trash.paths[0] != f.folder {
		t.Errorf("trashed %v, want the entry folder %s", f.trash.paths, f.folder)
	}
	if len(f.dl.cancelled) != 1 || f.dl.cancelled[0] != entryID {
		t.Errorf("cancelled %v, want [%s]", f.dl.cancelled, entryID)
	}
}

func TestRemoveModelBusy(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "llama.gguf")
	f.list = []models.Model{{ID: "llama", Path: p[0], Parts: p}}
	f.router.states = []provider.ModelState{{ID: "llama", State: provider.StateReady, Busy: true}}
	if err := f.removeModel("llama"); !errors.Is(err, ErrModelBusy) {
		t.Fatalf("err = %v, want ErrModelBusy", err)
	}
	if len(f.router.unloaded) != 0 || len(f.trash.paths) != 0 {
		t.Errorf("unloaded %v, trashed %v; want nothing", f.router.unloaded, f.trash.paths)
	}
}

func TestRemoveModelUnloadsFirst(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "llama.gguf")
	f.list = []models.Model{{ID: "llama", Path: p[0], Parts: p}}
	f.router.states = []provider.ModelState{{ID: "llama", State: provider.StateReady}}
	f.router.stopAfter = 2
	stoppedFirst := false
	f.cfg.Trash = func(path string) error {
		stoppedFirst = len(f.router.States()) == 0
		return f.trash.move(path)
	}
	if err := f.removeModel("llama"); err != nil {
		t.Fatalf("RemoveModel: %v", err)
	}
	if !slices.Equal(f.router.unloaded, []string{"llama"}) {
		t.Errorf("unloaded %v, want [llama]", f.router.unloaded)
	}
	if !stoppedFirst {
		t.Error("the file moved while the model was still running")
	}
}

func TestRemoveModelNotFound(t *testing.T) {
	f := newFixture(t)
	if err := f.removeModel("nope"); !errors.Is(err, provider.ErrUnknownModel) {
		t.Fatalf("err = %v, want provider.ErrUnknownModel", err)
	}
	f.cfg.ModelsDir = func() string { return "" }
	if err := f.removeModel("nope"); !errors.Is(err, catalog.ErrNoFolder) {
		t.Fatalf("no folder: err = %v, want catalog.ErrNoFolder", err)
	}
}

func TestRemoveModelOutside(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "split-00001-of-00002.gguf")
	escaped := f.models + string(filepath.Separator) + ".." + string(filepath.Separator) + "split-00002-of-00002.gguf"
	f.list = []models.Model{{ID: "split", Path: p[0], Parts: []string{p[0], escaped}}}
	if err := f.removeModel("split"); !errors.Is(err, ErrOutside) {
		t.Fatalf("err = %v, want ErrOutside", err)
	}
	if len(f.trash.paths) != 0 {
		t.Errorf("trashed %v, want nothing", f.trash.paths)
	}
}

func TestRemoveModelSymlinkOutside(t *testing.T) {
	f := newFixture(t)
	target := filepath.Join(t.TempDir(), "elsewhere.gguf")
	if err := os.WriteFile(target, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.models, "link.gguf")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create a symlink here: %v", err)
	}
	f.list = []models.Model{{ID: "link", Path: link, Parts: []string{link}}}
	if err := f.removeModel("link"); !errors.Is(err, ErrOutside) {
		t.Fatalf("err = %v, want ErrOutside", err)
	}
	if len(f.trash.paths) != 0 {
		t.Errorf("trashed %v, want nothing", f.trash.paths)
	}
}

// pick makes a Hugging Face pick's quant folder with a model and its projector, and lists the model.
func (f *fixture) pick(t *testing.T) (model, folder string) {
	t.Helper()
	p := f.own(t, "hf/o/r/Q4_K_M/m-Q4_K_M.gguf", "hf/o/r/Q4_K_M/mmproj-F16.gguf")
	folder = filepath.Dir(p[0])
	f.dl.pickID, f.dl.pickFolder = "hf:o/r:Q4_K_M", folder
	f.list = []models.Model{{ID: "m-Q4_K_M", Path: p[0], Parts: p[:1], MMProj: p[1]}}
	return "m-Q4_K_M", folder
}

func TestRemoveModelOfAPickTrashesItsFolderAndForgetsIt(t *testing.T) {
	f := newFixture(t)
	id, folder := f.pick(t)
	if err := f.removeModel(id); err != nil {
		t.Fatalf("RemoveModel: %v", err)
	}
	if !slices.Equal(f.trash.paths, []string{folder}) {
		t.Errorf("trashed %v, want [%s]", f.trash.paths, folder)
	}
	if !slices.Equal(f.dl.forgotten, []string{"hf:o/r:Q4_K_M"}) {
		t.Errorf("forgot %v, want [hf:o/r:Q4_K_M]", f.dl.forgotten)
	}
	if f.router.notified != 1 {
		t.Errorf("Notify called %d times, want 1", f.router.notified)
	}
}

func TestRemoveModelOfAPickLinkedOutside(t *testing.T) {
	f := newFixture(t)
	elsewhere := t.TempDir()
	if err := os.WriteFile(filepath.Join(elsewhere, "m-Q4_K_M.gguf"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(f.models, "hf", "o", "r"), 0o755); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(f.models, "hf", "o", "r", "Q4_K_M")
	if err := os.Symlink(elsewhere, folder); err != nil {
		t.Skipf("cannot create a symlink here: %v", err)
	}
	model := filepath.Join(folder, "m-Q4_K_M.gguf")
	f.dl.pickID, f.dl.pickFolder = "hf:o/r:Q4_K_M", folder
	f.list = []models.Model{{ID: "m-Q4_K_M", Path: model, Parts: []string{model}}}
	if err := f.removeModel("m-Q4_K_M"); !errors.Is(err, ErrOutside) {
		t.Fatalf("err = %v, want ErrOutside", err)
	}
	if len(f.trash.paths) != 0 || len(f.dl.forgotten) != 0 {
		t.Errorf("trashed %v, forgot %v; want nothing", f.trash.paths, f.dl.forgotten)
	}
}

func TestRemoveModelOfAPickSucceedsWhenForgettingFails(t *testing.T) {
	f := newFixture(t)
	id, _ := f.pick(t)
	f.dl.forgetErr = errors.New("database is locked")
	if err := f.removeModel(id); err != nil {
		t.Fatalf("RemoveModel: %v", err)
	}
	if f.warnings() != 1 {
		t.Errorf("%d warnings, want 1:\n%s", f.warnings(), f.log)
	}
}

func TestRemoveModelTrashFails(t *testing.T) {
	f := newFixture(t)
	p := f.own(t, "two-00001-of-00002.gguf", "two-00002-of-00002.gguf")
	f.list = []models.Model{{ID: "two", Path: p[0], Parts: p}}
	f.trash.failPath = p[1]
	if err := f.removeModel("two"); !errors.Is(err, ErrTrashFailed) {
		t.Fatalf("err = %v, want ErrTrashFailed", err)
	}
	if want := []string{p[0], p[1], p[1], p[1]}; !slices.Equal(f.trash.paths, want) {
		t.Errorf("trashed %v, want %v", f.trash.paths, want)
	}
	if !strings.Contains(f.log.String(), p[1]) {
		t.Errorf("the log does not name the file that failed:\n%s", f.log)
	}
}

func TestRemoveModelSharesRemovesTurn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(t)
		p := f.own(t, "llama.gguf")
		f.list = []models.Model{{ID: "llama", Path: p[0], Parts: p}}
		release := make(chan struct{})
		inTrash := make(chan struct{})
		f.cfg.Trash = func(path string) error {
			inTrash <- struct{}{}
			<-release
			return f.trash.move(path)
		}
		f.catalog.entered = make(chan struct{}, 1)
		r := New(f.cfg)

		errs := make(chan error, 2)
		go func() { errs <- r.RemoveModel(context.Background(), "llama") }()
		<-inTrash
		go func() { errs <- r.Remove(context.Background(), entryID) }()
		synctest.Wait() // the catalog removal waits for its turn
		if n := len(f.catalog.entered); n != 0 {
			t.Fatalf("Folder called %d times while RemoveModel was moving, want 0", n)
		}

		close(release)
		if err := <-errs; err != nil {
			t.Fatalf("RemoveModel: %v", err)
		}
		<-inTrash
		if err := <-errs; err != nil {
			t.Fatalf("Remove: %v", err)
		}
		if n := len(f.catalog.entered); n != 1 {
			t.Errorf("Folder called %d times, want 1", n)
		}
	})
}

// The rest of provider.Resident: a removal never calls it.
func (f *fakeRouter) Load(context.Context, string) error   { return nil }
func (f *fakeRouter) Subscribe() (<-chan struct{}, func()) { return nil, func() {} }
