package downloads

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/download"
)

const testTag = "b1"

var engineZips = map[string][]byte{
	"engine.zip":  []byte(strings.Repeat("engine-bytes-", 500)),
	"runtime.zip": []byte(strings.Repeat("runtime-bytes-", 500)),
}

func engineFile(name string) catalog.File {
	s := sha256.Sum256(engineZips[name])
	return catalog.File{Name: name, SizeBytes: int64(len(engineZips[name])), SHA256: hex.EncodeToString(s[:])}
}

type engineFixture struct {
	m      *Manager
	engine *Engine
	gate   chan struct{} // when set, each response waits for it
}

// newEngineFixture serves the two fake zips; extract stands in for tar.exe.
func newEngineFixture(t *testing.T, gated bool, extract func(ctx context.Context, zip, dest string) error) *engineFixture {
	t.Helper()
	f := &engineFixture{}
	if gated {
		f.gate = make(chan struct{})
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.gate != nil {
			select {
			case <-f.gate:
			case <-r.Context().Done():
				return
			}
		}
		if !strings.HasPrefix(r.URL.Path, "/"+testTag+"/") {
			http.NotFound(w, r)
			return
		}
		body, ok := engineZips[filepath.Base(r.URL.Path)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	f.engine = &Engine{
		Tag: testTag, Dir: t.TempDir(), Files: []catalog.File{engineFile("engine.zip"), engineFile("runtime.zip")},
		Extract: extract, baseURL: srv.URL, allowHost: func(string) bool { return true },
	}
	f.m = New(Config{
		Downloader: &download.Downloader{
			Client: &http.Client{}, AllowHost: func(string) bool { return false }, AllowLocalHTTP: true,
			Backoff: []time.Duration{time.Millisecond},
		},
		ModelsDir: func() string { return t.TempDir() },
		DiskFree:  func(string) (uint64, error) { return 1 << 40, nil },
		Engine:    f.engine,
	})
	t.Cleanup(f.m.Close)
	return f
}

// fakeExtract writes llama-server.exe for the engine zip and a DLL for the runtime zip.
func fakeExtract(_ context.Context, zip, dest string) error {
	name := "cudart64.dll"
	if filepath.Base(zip) == "engine.zip" {
		name = "llama-server.exe"
	}
	return os.WriteFile(filepath.Join(dest, name), []byte("x"), 0o644)
}

func (f *engineFixture) wait(t *testing.T, want State) Item {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, it := range f.m.Items() {
			if it.ID == EngineID && it.State == want {
				return it
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("engine never reached %q: %+v", want, f.m.Items())
	return Item{}
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func TestEngineDownloadsUnpacksAndLeavesOnlyTheFinalFolder(t *testing.T) {
	f := newEngineFixture(t, false, fakeExtract)
	if err := f.m.StartEngine(); err != nil {
		t.Fatal(err)
	}
	it := f.wait(t, Done)
	if it.Total != int64(len(engineZips["engine.zip"])+len(engineZips["runtime.zip"])) {
		t.Fatalf("total = %d", it.Total)
	}
	final := filepath.Join(f.engine.Dir, testTag+"-cuda")
	for _, name := range []string{"llama-server.exe", "cudart64.dll"} {
		if !exists(filepath.Join(final, name)) {
			t.Fatalf("%s missing from %s", name, final)
		}
	}
	for _, leftover := range []string{testTag + "-cuda.download", testTag + "-cuda.tmp"} {
		if exists(filepath.Join(f.engine.Dir, leftover)) {
			t.Fatalf("%s was not cleaned up", leftover)
		}
	}
	if err := f.m.StartEngine(); !errors.Is(err, ErrInstalled) {
		t.Fatalf("second start = %v, want ErrInstalled", err)
	}
}

func TestEngineUnpackFailureKeepsTheZipsAndRetrySucceeds(t *testing.T) {
	broken := true
	f := newEngineFixture(t, false, func(ctx context.Context, zip, dest string) error {
		if broken {
			return errors.New("tar failed")
		}
		return fakeExtract(ctx, zip, dest)
	})
	_ = f.m.StartEngine()
	f.wait(t, Failed)
	if exists(filepath.Join(f.engine.Dir, testTag+"-cuda")) || exists(filepath.Join(f.engine.Dir, testTag+"-cuda.tmp")) {
		t.Fatal("a failed unpack left an engine folder behind")
	}
	if !exists(filepath.Join(f.engine.Dir, testTag+"-cuda.download", "engine.zip")) {
		t.Fatal("the downloaded zips should stay for the retry")
	}
	broken = false
	if err := f.m.Resume(EngineID); err != nil {
		t.Fatal(err)
	}
	f.wait(t, Done)
}

func TestEngineWithoutServerExeInTheZipsFails(t *testing.T) {
	f := newEngineFixture(t, false, func(_ context.Context, _, dest string) error {
		return os.WriteFile(filepath.Join(dest, "readme.txt"), []byte("x"), 0o644)
	})
	_ = f.m.StartEngine()
	f.wait(t, Failed)
	if exists(filepath.Join(f.engine.Dir, testTag+"-cuda")) {
		t.Fatal("a folder without llama-server.exe must not count as installed")
	}
}

func TestCancellingTheEngineDeletesWhatItWrote(t *testing.T) {
	f := newEngineFixture(t, true, fakeExtract)
	_ = f.m.StartEngine()
	f.wait(t, Downloading)
	if err := f.m.Cancel(EngineID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(f.m.Items()) > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(f.m.Items()) > 0 || exists(filepath.Join(f.engine.Dir, testTag+"-cuda.download")) {
		t.Fatal("the job and its download folder should be gone after Cancel")
	}
}

func TestStartEngineWithoutAManifestIsUnknown(t *testing.T) {
	f := newFixture(t, false)
	if err := f.m.StartEngine(); !errors.Is(err, ErrUnknown) {
		t.Fatalf("got %v, want ErrUnknown", err)
	}
}

func TestEngineNeedsRoomForTheUnpackedFiles(t *testing.T) {
	f := newEngineFixture(t, false, fakeExtract)
	zips := int64(len(engineZips["engine.zip"]) + len(engineZips["runtime.zip"]))
	f.m.cfg.DiskFree = func(string) (uint64, error) { return uint64(zips + diskSpare), nil } // fits the zips, not the unpacking
	if err := f.m.StartEngine(); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("got %v, want ErrNoSpace", err)
	}
}

func writeManifest(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "llama.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const goodSHA = "be47cb0829cc229624e4f2fce2567fbaa9d8453adcced9f5f103862d20b2c33b"

func TestLoadEngineReadsTheCudaPin(t *testing.T) {
	p := writeManifest(t, `{"tag":"b12078","asset":"v.zip","sha256":"`+goodSHA+`","cuda":{"asset":"a.zip","size":5,"sha256":"`+goodSHA+`","runtime":{"asset":"r.zip","size":7,"sha256":"`+goodSHA+`"}}}`)
	e, err := LoadEngine(p, `C:\engines`)
	if err != nil || e == nil {
		t.Fatalf("LoadEngine = %v, %v", e, err)
	}
	if e.Tag != "b12078" || len(e.Files) != 2 || e.Files[0].Name != "a.zip" || e.Files[1].SizeBytes != 7 {
		t.Fatalf("got %+v", e)
	}
}

func TestLoadEngineWithoutCudaIsNil(t *testing.T) {
	e, err := LoadEngine(writeManifest(t, `{"tag":"b1","asset":"v.zip","sha256":"`+goodSHA+`"}`), "x")
	if e != nil || err != nil {
		t.Fatalf("got %v, %v", e, err)
	}
}

func TestLoadEngineRejectsNamesThatCouldEscapeTheFolder(t *testing.T) {
	cuda := func(asset string) string {
		return `{"tag":"b1","cuda":{"asset":"` + asset + `","size":5,"sha256":"` + goodSHA + `","runtime":{"asset":"r.zip","size":7,"sha256":"` + goodSHA + `"}}}`
	}
	for _, asset := range []string{`../evil.zip`, `a/b.zip`, `a.exe`, ``} {
		if _, err := LoadEngine(writeManifest(t, cuda(asset)), "x"); err == nil {
			t.Fatalf("asset %q was accepted", asset)
		}
	}
	for _, tag := range []string{`..`, `b1/../x`, ``} {
		body := strings.Replace(cuda("a.zip"), `"tag":"b1"`, `"tag":"`+tag+`"`, 1)
		if _, err := LoadEngine(writeManifest(t, body), "x"); err == nil {
			t.Fatalf("tag %q was accepted", tag)
		}
	}
	if _, err := LoadEngine(writeManifest(t, strings.Replace(cuda("a.zip"), goodSHA, "nothex", 1)), "x"); err == nil {
		t.Fatal("a bad checksum was accepted")
	}
	if _, err := LoadEngine(filepath.Join(t.TempDir(), "missing.json"), "x"); err == nil {
		t.Fatal("a missing file was accepted")
	}
}

func TestEngineComesFromGitHubOnly(t *testing.T) {
	e := &Engine{Tag: "b12078", Dir: "x", Files: []catalog.File{{Name: "a.zip"}}}
	tg := e.target()
	if got := tg.url(tg.files[0]); got != "https://github.com/ggml-org/llama.cpp/releases/download/b12078/a.zip" {
		t.Fatalf("url = %s", got)
	}
	for host, want := range map[string]bool{
		"github.com": true, "release-assets.githubusercontent.com": true, "objects.githubusercontent.com": true,
		"huggingface.co": false, "evilgithub.com": false, "raw.githubusercontent.com": false, "github.com.evil.io": false,
	} {
		if tg.allowHost(host) != want {
			t.Errorf("allowHost(%q) = %v, want %v", host, !want, want)
		}
	}
}

func TestTarExtractUnpacksARealZip(t *testing.T) {
	if _, err := exec.LookPath(filepath.Join(os.Getenv("SystemRoot"), "System32", "tar.exe")); err != nil {
		t.Skip("Windows' tar.exe is not available")
	}
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "x.zip")
	out, _ := os.Create(zipPath)
	zw := zip.NewWriter(out)
	w, _ := zw.Create("llama-server.exe")
	_, _ = w.Write([]byte("exe"))
	_ = zw.Close()
	_ = out.Close()

	dest := filepath.Join(dir, "out")
	_ = os.Mkdir(dest, 0o755)
	if err := tarExtract(context.Background(), zipPath, dest); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "llama-server.exe")); string(got) != "exe" {
		t.Fatalf("extracted %q", got)
	}
	if err := tarExtract(context.Background(), filepath.Join(dir, "missing.zip"), dest); err == nil {
		t.Fatal("a missing zip should fail")
	}
}
