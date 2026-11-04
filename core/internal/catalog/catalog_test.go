package catalog

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/hw"
)

func TestBuiltinIsValid(t *testing.T) {
	entries, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 5 || len(entries) > 10 {
		t.Fatalf("%d entries, the spec asks for 5–10", len(entries))
	}
	var chat, code, vision bool
	for _, e := range entries {
		chat = chat || slices.Contains(e.Tags, "chat")
		code = code || slices.Contains(e.Tags, "code")
		vision = vision || slices.Contains(e.Tags, "vision")
	}
	if !chat || !code || !vision {
		t.Fatalf("needs a chat, a code and a vision model: chat=%v code=%v vision=%v", chat, code, vision)
	}
}

const goodSHA = "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"

// entryJSON is a valid entry with one field replaced (old → new), to test each rule on its own.
func entryJSON(old, new string) string {
	e := `{"id":"m-1","name":"M","summary":"S.","tags":["chat"],"licence":"MIT","repo":"org/m-GGUF",` +
		`"revision":"e87f176479d0855a907a41277aca2f8ee7a09523",` +
		`"files":[{"name":"m.gguf","sizeBytes":10,"sha256":"` + goodSHA + `"}],"needsGB":4,"rank":1}`
	return strings.Replace(e, old, new, 1)
}

func TestParseRejects(t *testing.T) {
	tests := map[string]string{
		"path in id":        "[" + entryJSON(`"id":"m-1"`, `"id":"..\\m"`) + "]",
		"upper-case id":     "[" + entryJSON(`"id":"m-1"`, `"id":"M"`) + "]",
		"short revision":    "[" + entryJSON(`a09523"`, `"`) + "]",
		"branch revision":   "[" + entryJSON(`"e87f176479d0855a907a41277aca2f8ee7a09523"`, `"main"`) + "]",
		"unknown tag":       "[" + entryJSON(`["chat"]`, `["chat","music"]`) + "]",
		"no files":          "[" + entryJSON(`[{"name":"m.gguf","sizeBytes":10,"sha256":"`+goodSHA+`"}]`, `[]`) + "]",
		"path in file name": "[" + entryJSON(`"name":"m.gguf"`, `"name":"../m.gguf"`) + "]",
		"not a gguf":        "[" + entryJSON(`"name":"m.gguf"`, `"name":"m.exe"`) + "]",
		"no size":           "[" + entryJSON(`"sizeBytes":10`, `"sizeBytes":0`) + "]",
		"missing sha256":    "[" + entryJSON(goodSHA, "") + "]",
		"upper-case sha256": "[" + entryJSON(goodSHA, strings.ToUpper(goodSHA)) + "]",
		"no needsGB":        "[" + entryJSON(`"needsGB":4`, `"needsGB":0`) + "]",
		"misspelt key":      "[" + entryJSON(`"rank"`, `"rnak"`) + "]",
		"duplicate id":      "[" + entryJSON("", "") + "," + entryJSON("", "") + "]",
		"not a list":        "{}",
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(data)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	if _, err := Parse([]byte("[" + entryJSON("", "") + "]")); err != nil {
		t.Fatalf("the valid entry was rejected: %v", err)
	}
}

func gpu(gb uint64) *hw.GPU { return &hw.GPU{Name: "GPU", TotalBytes: gb * gib} }

func TestFitFor(t *testing.T) {
	tests := []struct {
		name    string
		needsGB int
		report  hw.Report
		want    string
	}{
		{"well inside the GPU", 7, hw.Report{GPU: gpu(12), RAMBytes: 32 * gib}, FitFits},
		{"exactly 90 % of the GPU", 9, hw.Report{GPU: gpu(10), RAMBytes: 32 * gib}, FitFits},
		{"just over 90 %", 10, hw.Report{GPU: gpu(10), RAMBytes: 32 * gib}, FitSlower},
		{"GPU plus half the RAM", 28, hw.Report{GPU: gpu(12), RAMBytes: 32 * gib}, FitSlower},
		{"more than GPU plus half the RAM", 29, hw.Report{GPU: gpu(12), RAMBytes: 32 * gib}, FitTooBig},
		{"no GPU, fits in half the RAM", 8, hw.Report{RAMBytes: 16 * gib}, FitSlower},
		{"no GPU, over half the RAM", 9, hw.Report{RAMBytes: 16 * gib}, FitTooBig},
		{"nothing measured", 1, hw.Report{}, FitTooBig},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FitFor(tt.needsGB, tt.report); got != tt.want {
				t.Fatalf("FitFor(%d) = %q, want %q", tt.needsGB, got, tt.want)
			}
		})
	}
}

func item(id string, rank int, fit string, tags ...string) Item {
	return Item{Entry: Entry{ID: id, Rank: rank, Tags: tags}, Fit: fit}
}

func TestRecommend(t *testing.T) {
	tests := []struct {
		name  string
		items []Item
		want  string // "" for none
	}{
		{"best chat model that fits", []Item{
			item("small", 20, FitFits, "chat"), item("mid", 40, FitFits, "chat", "vision"), item("big", 80, FitSlower, "chat"),
		}, "mid"},
		{"code models are never the pick", []Item{
			item("chat", 20, FitFits, "chat"), item("coder", 90, FitFits, "code"),
		}, "chat"},
		{"slower when nothing fits", []Item{
			item("a", 20, FitSlower, "chat"), item("b", 50, FitSlower, "chat"), item("c", 90, FitTooBig, "chat"),
		}, "b"},
		{"none when everything is too big", []Item{item("a", 20, FitTooBig, "chat")}, ""},
		{"a tie keeps list order", []Item{item("first", 30, FitFits, "chat"), item("second", 30, FitFits, "chat")}, "first"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ""
			if p := recommend(tt.items); p != nil {
				got = *p
			}
			if got != tt.want {
				t.Fatalf("recommend = %q, want %q", got, tt.want)
			}
		})
	}
}

// testCatalog has two entries: "one" (3 + 2 bytes, chat) and "two" (1 GiB, chat, higher rank).
func testCatalog(dir string, free uint64, freeErr error) *Catalog {
	entries := []Entry{
		{ID: "one", Tags: []string{"chat"}, NeedsGB: 4, Rank: 10, Files: []File{{Name: "a.gguf", SizeBytes: 3}, {Name: "mmproj.gguf", SizeBytes: 2}}},
		{ID: "two", Tags: []string{"chat"}, NeedsGB: 4, Rank: 20, Files: []File{{Name: "b.gguf", SizeBytes: gib}}},
	}
	c := New(entries, func() hw.Report { return hw.Report{GPU: gpu(8), RAMBytes: 16 * gib} }, func() string { return dir })
	c.diskFree = func(string) (uint64, error) { return free, freeErr }
	return c
}

func write(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestViewInstalledNeedsEveryFileAtFullSize(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "one", "a.gguf"), 3)
	write(t, filepath.Join(dir, "one", "mmproj.gguf"), 2)
	write(t, filepath.Join(dir, "two", "b.gguf"), 5) // a wrong size is not installed

	v := testCatalog(dir, 100*gib, nil).View()
	if !v.Entries[0].Installed || v.Entries[1].Installed {
		t.Fatalf("installed = %v, %v; want true, false", v.Entries[0].Installed, v.Entries[1].Installed)
	}

	_ = os.Remove(filepath.Join(dir, "one", "mmproj.gguf"))
	if testCatalog(dir, 100*gib, nil).View().Entries[0].Installed {
		t.Fatal("installed without its projector")
	}
}

func TestViewDiskSpace(t *testing.T) {
	// The folder doesn't exist yet: the drive is still read, through the nearest parent that does.
	dir := filepath.Join(t.TempDir(), "not", "made", "yet")
	v := testCatalog(dir, gib+diskSpare-1, nil).View()
	if v.DiskFreeBytes == nil || *v.DiskFreeBytes != gib+diskSpare-1 {
		t.Fatalf("diskFreeBytes = %v", v.DiskFreeBytes)
	}
	if v.Entries[0].DiskShortBytes != 0 {
		t.Fatalf("one: short %d, want 0", v.Entries[0].DiskShortBytes)
	}
	if v.Entries[1].DiskShortBytes != 1 {
		t.Fatalf("two: short %d, want 1 byte", v.Entries[1].DiskShortBytes)
	}

	// An unreadable drive never blocks a download.
	v = testCatalog(dir, 0, errors.New("access denied")).View()
	if v.DiskFreeBytes != nil || v.Entries[1].DiskShortBytes != 0 {
		t.Fatalf("diskFreeBytes = %v, short = %d", v.DiskFreeBytes, v.Entries[1].DiskShortBytes)
	}
}

func TestViewInstalledNeedsNoSpace(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "one", "a.gguf"), 3)
	write(t, filepath.Join(dir, "one", "mmproj.gguf"), 2)
	if short := testCatalog(dir, 0, nil).View().Entries[0].DiskShortBytes; short != 0 {
		t.Fatalf("an installed model is short %d bytes", short)
	}
}

func TestViewWithoutModelsFolder(t *testing.T) {
	v := testCatalog("", 100*gib, nil).View()
	if v.DiskFreeBytes != nil || v.Entries[0].Installed {
		t.Fatalf("view = %+v", v)
	}
	if v.Recommended == nil || *v.Recommended != "two" {
		t.Fatalf("recommended = %v, want two", v.Recommended)
	}
}

func TestFolder(t *testing.T) {
	dir := t.TempDir()
	if got, err := testCatalog(dir, 0, nil).Folder("one"); err != nil || got != filepath.Join(dir, "one") {
		t.Fatalf("Folder = %q, %v", got, err)
	}
	if _, err := testCatalog(dir, 0, nil).Folder("..\\one"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("unknown id: err = %v", err)
	}
	if _, err := testCatalog("", 0, nil).Folder("one"); !errors.Is(err, ErrNoFolder) {
		t.Fatalf("no folder: err = %v", err)
	}
}

func TestBaseURLOnlyInTestCatalogAndOnlyLocal(t *testing.T) {
	entry := func(base string) []byte {
		return []byte(`[{"id":"x","name":"X","summary":"s","tags":["chat"],"licence":"MIT","repo":"o/x","revision":"` +
			strings.Repeat("a", 40) + `","files":[{"name":"x.gguf","sizeBytes":1,"sha256":"` + strings.Repeat("b", 64) +
			`"}],"needsGB":1,"rank":1,"baseUrl":"` + base + `"}]`)
	}
	if _, err := Parse(entry("http://127.0.0.1:1234")); err == nil {
		t.Fatal("the normal parser accepted a baseUrl")
	}
	if _, err := ParseTest(entry("http://127.0.0.1:1234")); err != nil {
		t.Fatalf("test catalog with a local baseUrl: %v", err)
	}
	for _, bad := range []string{"https://evil.example", "http://evil.example", "http://127.0.0.1.evil.example", "ftp://127.0.0.1"} {
		if _, err := ParseTest(entry(bad)); err == nil {
			t.Fatalf("test catalog accepted %q", bad)
		}
	}
}
