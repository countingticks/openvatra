package downloads

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/store"
)

var (
	pickRev   = strings.Repeat("b", 40)
	pickFiles = map[string][]byte{ // path in the repo -> body
		"m-Q4_K_M-00001-of-00002.gguf": []byte(strings.Repeat("first-part-", 300)),
		"m-Q4_K_M-00002-of-00002.gguf": []byte(strings.Repeat("second-part-", 300)),
		"proj/mmproj-F16.gguf":         []byte(strings.Repeat("projector-", 300)),
	}
	pickOrder = []string{"m-Q4_K_M-00001-of-00002.gguf", "m-Q4_K_M-00002-of-00002.gguf", "proj/mmproj-F16.gguf"}
)

// pickFixture serves pickFiles at /o/r/resolve/<pickRev>/<path> and keeps picks in a real store. With stall set, the
// next first request (no Range) stops after stallAt bytes, once.
type pickFixture struct {
	m     *Manager
	st    *store.Store
	dir   string // the models folder
	srv   *httptest.Server
	free  atomic.Uint64
	stall atomic.Bool
}

func newPickFixture(t *testing.T) *pickFixture {
	t.Helper()
	f := &pickFixture{dir: t.TempDir()}
	f.free.Store(1 << 40)
	prefix := "/o/r/resolve/" + pickRev + "/"
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := pickFiles[strings.TrimPrefix(r.URL.Path, prefix)]
		if !ok || !strings.HasPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}
		serve(w, r, body, r.Header.Get("Range") == "" && f.stall.CompareAndSwap(true, false))
	}))
	t.Cleanup(f.srv.Close)
	st, err := store.Open(t.TempDir(), event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f.st = st
	f.m = f.newManager(t)
	return f
}

// newManager is a manager on the fixture's store, as core makes one at start.
func (f *pickFixture) newManager(t *testing.T) *Manager {
	t.Helper()
	picks, err := LoadPicks(context.Background(), f.st, f.srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Config{
		Downloader: testDownloader(),
		ModelsDir:  func() string { return f.dir },
		DiskFree:   func(string) (uint64, error) { return f.free.Load(), nil },
		Picks:      picks,
	})
	t.Cleanup(m.Close)
	return m
}

func (f *pickFixture) folder() string { return filepath.Join(f.dir, "hf", "o", "r", "Q4_K_M") }

func (f *pickFixture) rows(t *testing.T) []store.HFPick {
	t.Helper()
	rows, err := f.st.HFPicks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func testPick() store.HFPick {
	p := store.HFPick{ID: "hf:o/r:Q4_K_M", Repo: "o/r", Revision: pickRev, Quant: "Q4_K_M"}
	for _, path := range pickOrder {
		sum := sha256.Sum256(pickFiles[path])
		p.Files = append(p.Files, store.HFPickFile{Name: filepath.Base(path), Path: path,
			SizeBytes: int64(len(pickFiles[path])), SHA256: hex.EncodeToString(sum[:])})
	}
	return p
}

func waitGone(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for exists(path) {
		if time.Now().After(deadline) {
			t.Fatalf("%s is still there", path)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func isState(s State) func(DownloadItem) bool {
	return func(it DownloadItem) bool { return it.State == s }
}

func TestPickDownloadsEveryFileIntoItsQuantFolderAndIsSaved(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	if err := f.m.StartPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	it := waitItem(t, f.m, p.ID, isState(Done))
	if it.Name != "m-Q4_K_M-00001-of-00002.gguf" {
		t.Fatalf("name = %q", it.Name)
	}
	for _, path := range pickOrder {
		got, err := os.ReadFile(filepath.Join(f.folder(), filepath.Base(path)))
		if err != nil || string(got) != string(pickFiles[path]) {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if rows := f.rows(t); len(rows) != 1 || rows[0].ID != p.ID || len(rows[0].Files) != 3 {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestPickClosedMidFileIsPausedAfterARestartAndResumes(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	f.stall.Store(true)
	if err := f.m.StartPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, func(it DownloadItem) bool { return it.State == Downloading && it.Bytes == stallAt })
	f.m.Close()

	m := f.newManager(t)
	it := item(m, p.ID)
	if it.State != Paused || it.Bytes != stallAt || it.Total != testPickTotal() {
		t.Fatalf("after the restart: %+v", it)
	}
	if err := m.Resume(p.ID); err != nil {
		t.Fatal(err)
	}
	waitItem(t, m, p.ID, isState(Done))
}

func testPickTotal() int64 {
	var n int64
	for _, b := range pickFiles {
		n += int64(len(b))
	}
	return n
}

func TestPickRefusalsSaveNoRow(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	_ = os.MkdirAll(f.folder(), 0o755)
	for _, path := range pickOrder {
		_ = os.WriteFile(filepath.Join(f.folder(), filepath.Base(path)), pickFiles[path], 0o644)
	}
	if err := f.m.StartPick(context.Background(), p); !errors.Is(err, ErrInstalled) {
		t.Fatalf("installed = %v", err)
	}
	if rows := f.rows(t); len(rows) != 0 {
		t.Fatalf("rows after installed = %+v", rows)
	}

	_ = os.RemoveAll(filepath.Join(f.dir, "hf"))
	f.free.Store(1 << 20)
	if err := f.m.StartPick(context.Background(), p); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("no space = %v", err)
	}
	if rows := f.rows(t); len(rows) != 0 {
		t.Fatalf("rows after no space = %+v", rows)
	}
	if items := f.m.Items(); len(items) != 0 {
		t.Fatalf("items = %+v", items)
	}
}

func TestPickStartedAgainKeepsItsStoredRevision(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	f.stall.Store(true)
	if err := f.m.StartPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, func(it DownloadItem) bool { return it.State == Downloading && it.Bytes == stallAt })
	if err := f.m.Pause(p.ID); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, isState(Paused))

	other := testPick()
	other.Revision = strings.Repeat("c", 40) // the server knows only pickRev: this one would fail
	if err := f.m.StartPick(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, isState(Done))
	if rows := f.rows(t); len(rows) != 1 || rows[0].Revision != pickRev {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestPickCancelDeletesItsFilesFoldersAndRow(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	f.stall.Store(true)
	if err := f.m.StartPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, func(it DownloadItem) bool { return it.State == Downloading && it.Bytes == stallAt })
	if err := f.m.Cancel(p.ID); err != nil {
		t.Fatal(err)
	}
	waitGone(t, filepath.Join(f.dir, "hf"))
	if rows := f.rows(t); len(rows) != 0 {
		t.Fatalf("rows = %+v", rows)
	}
	if it := item(f.m, p.ID); it.ID != "" {
		t.Fatalf("item = %+v", it)
	}
}

func TestPickCancelKeepsAFolderWithTheUsersFile(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	f.stall.Store(true)
	if err := f.m.StartPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, func(it DownloadItem) bool { return it.State == Downloading && it.Bytes == stallAt })
	if err := f.m.Pause(p.ID); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, isState(Paused))
	mine := filepath.Join(f.dir, "hf", "o", "notes.txt")
	_ = os.WriteFile(mine, []byte("mine"), 0o644)

	if err := f.m.Cancel(p.ID); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(f.dir, "hf", "o", "r")) {
		t.Fatal("the empty repo folder is still there")
	}
	if !exists(mine) {
		t.Fatal("the user's file was deleted")
	}
	if rows := f.rows(t); len(rows) != 0 {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestForgetPickDropsTheRowAndTheItemAndKeepsTheFiles(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	if err := f.m.StartPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	waitItem(t, f.m, p.ID, isState(Done))
	if err := f.m.ForgetPick(context.Background(), p.ID); err != nil {
		t.Fatal(err)
	}
	if rows := f.rows(t); len(rows) != 0 {
		t.Fatalf("rows = %+v", rows)
	}
	if it := item(f.m, p.ID); it.ID != "" {
		t.Fatalf("item = %+v", it)
	}
	if !exists(filepath.Join(f.folder(), "m-Q4_K_M-00001-of-00002.gguf")) {
		t.Fatal("forgetting deleted the model")
	}
	if err := f.m.ForgetPick(context.Background(), p.ID); !errors.Is(err, ErrNoDownload) {
		t.Fatalf("second forget = %v", err)
	}
}

func TestPickOfFindsThePickOfItsFiles(t *testing.T) {
	f := newPickFixture(t)
	p := testPick()
	if err := f.st.SaveHFPick(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	m := f.newManager(t)
	upper := filepath.Join(strings.ToUpper(f.folder()), "M-Q4_K_M-00001-OF-00002.GGUF")
	id, folder, ok := m.PickOf(upper)
	if !ok || id != p.ID || !strings.EqualFold(folder, f.folder()) {
		t.Fatalf("PickOf = %q, %q, %v", id, folder, ok)
	}
	for _, outside := range []string{
		filepath.Join(f.dir, "hf", "o", "r", "m-Q4_K_M-00001-of-00002.gguf"),
		filepath.Join(f.folder(), "other.gguf"),
	} {
		if _, _, ok := m.PickOf(outside); ok {
			t.Fatalf("PickOf(%s) found a pick", outside)
		}
	}
}

func TestStartPickWithoutADatabaseIsRefused(t *testing.T) {
	m := New(Config{Downloader: testDownloader(), ModelsDir: func() string { return t.TempDir() }})
	t.Cleanup(m.Close)
	if err := m.StartPick(context.Background(), testPick()); !errors.Is(err, ErrNoPicks) {
		t.Fatalf("StartPick = %v, want ErrNoPicks", err)
	}
}

func TestLoadPicksSkipsARowThatClimbsOut(t *testing.T) {
	f := newPickFixture(t)
	bad := testPick()
	bad.Repo, bad.ID = "o/..", "hf:o/..:Q4_K_M"
	if err := f.st.SaveHFPick(context.Background(), bad); err != nil {
		t.Fatal(err)
	}
	m := f.newManager(t)
	if err := m.Cancel(bad.ID); !errors.Is(err, ErrUnknown) {
		t.Fatalf("cancel of the bad row = %v, want ErrUnknown", err)
	}
	if err := m.Resume(bad.ID); !errors.Is(err, ErrUnknown) {
		t.Fatalf("resume of the bad row = %v, want ErrUnknown", err)
	}
}
