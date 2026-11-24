package hf

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/catalog"
)

func quants(l Listing) []string {
	var out []string
	for _, g := range l.Groups {
		out = append(out, g.Quant)
	}
	return out
}

func group(t *testing.T, l Listing, quant string) Group {
	t.Helper()
	for _, g := range l.Groups {
		if g.Quant == quant {
			return g
		}
	}
	t.Fatalf("no group %q in %v", quant, quants(l))
	return Group{}
}

func names(g Group) []string {
	var out []string
	for _, f := range g.Files {
		out = append(out, f.Name)
	}
	return out
}

func TestFilesSplitRepo(t *testing.T) {
	routes := map[string]http.HandlerFunc{}
	owner, name := recordedRepo(t, routes, "qwen3-coder-30b")
	l, err := newFakeHF(t, routes).filesClient(t, t.TempDir()).Files(context.Background(), owner, name)
	if err != nil {
		t.Fatal(err)
	}
	if l.Repo != "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF" || l.Revision != "b17cb02dd882d5b6ab62fc777ad2995f19668350" {
		t.Fatalf("repo %q at %q", l.Repo, l.Revision)
	}
	// 26 single files and the BF16 split in two parts; every quant once.
	if len(l.Groups) != 27 {
		t.Fatalf("%d groups: %v", len(l.Groups), quants(l))
	}
	bf16 := group(t, l, "BF16")
	wantNames := []string{"Qwen3-Coder-30B-A3B-Instruct-BF16-00001-of-00002.gguf", "Qwen3-Coder-30B-A3B-Instruct-BF16-00002-of-00002.gguf"}
	if !slices.Equal(names(bf16), wantNames) {
		t.Fatalf("BF16 files = %v", names(bf16))
	}
	if bf16.Files[0].Path != "BF16/"+wantNames[0] || bf16.SizeBytes != 49655154016+11440652032 {
		t.Fatalf("BF16 = %+v", bf16)
	}
	if q := group(t, l, "UD-Q4_K_XL"); len(q.Files) != 1 || q.Files[0].SHA256 == "" {
		t.Fatalf("UD-Q4_K_XL = %+v", q)
	}
	if !slices.Equal(l.Tags, []string{"Code", "MoE"}) {
		t.Fatalf("tags = %v", l.Tags)
	}
}

func TestFilesSplitGroupMissingAPart(t *testing.T) {
	f := newFakeHF(t, fakeRepo(
		gguf("m-Q4_0-00001-of-00003.gguf", 10),
		gguf("m-Q4_0-00003-of-00003.gguf", 10),
		gguf("m-Q8_0.gguf", 10),
	))
	l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(quants(l), []string{"Q8_0"}) {
		t.Fatalf("quants = %v, want only Q8_0", quants(l))
	}
}

func TestFilesProjectorJoinsEveryGroup(t *testing.T) {
	routes := map[string]http.HandlerFunc{}
	owner, name := recordedRepo(t, routes, "gemma-3-4b")
	l, err := newFakeHF(t, routes).filesClient(t, t.TempDir()).Files(context.Background(), owner, name)
	if err != nil {
		t.Fatal(err)
	}
	// The repo also has mmproj-BF16 (same size) and mmproj-F32 (larger): F16 wins.
	if len(l.Groups) != 26 {
		t.Fatalf("%d groups: %v", len(l.Groups), quants(l))
	}
	for _, g := range l.Groups {
		last := g.Files[len(g.Files)-1]
		if len(g.Files) != 2 || last.Name != "mmproj-F16.gguf" || g.SizeBytes != g.Files[0].SizeBytes+851251328 {
			t.Fatalf("group %s = %+v", g.Quant, g)
		}
	}
	if !slices.Equal(l.Tags, []string{"Vision"}) {
		t.Fatalf("tags = %v, want Vision", l.Tags)
	}
}

func TestFilesNoQuantIsKeyedByStem(t *testing.T) {
	routes := map[string]http.HandlerFunc{}
	owner, name := recordedRepo(t, routes, "tiny-llamas")
	l, err := newFakeHF(t, routes).filesClient(t, t.TempDir()).Files(context.Background(), owner, name)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"stories260K", "Q4_0", "Q8_0", "stories15M"}; !slices.Equal(quants(l), want) {
		t.Fatalf("quants = %v, want %v (by size)", quants(l), want)
	}
	if !slices.Equal(l.Tags, []string{}) {
		t.Fatalf("tags = %#v, want []", l.Tags)
	}
}

func TestFilesSameQuantIsKeyedByStem(t *testing.T) {
	f := newFakeHF(t, fakeRepo(
		gguf("a-Q4_K_M.gguf", 10),
		gguf("b-Q4_K_M.gguf", 20),
		// The same stem in two folders: the label would be shared, so both are left out.
		gguf("x/m-Q8_0.gguf", 30),
		gguf("y/m-Q8_0.gguf", 30),
	))
	l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a-Q4_K_M", "b-Q4_K_M"}; !slices.Equal(quants(l), want) {
		t.Fatalf("quants = %v, want %v", quants(l), want)
	}
}

func TestFilesUnsafeFileDropsItsGroup(t *testing.T) {
	f := newFakeHF(t, fakeRepo(
		gguf("ok-Q4_0.gguf", 10),
		gguf("../evil-Q5_0.gguf", 10),
		gguf("sub/../x-Q6_K.gguf", 10),
		`{"type":"file","path":"nolfs-Q8_0.gguf","size":10}`,
		gguf("split-Q3_K_M-00001-of-00002.gguf", 10),
		gguf("split-Q3_K_M-00002-of-00002.gguf", 0),
		gguf("bad dir/mmproj-F16.gguf", 1), // a projector that fails is not offered
	))
	l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(quants(l), []string{"Q4_0"}) || len(l.Groups[0].Files) != 1 {
		t.Fatalf("groups = %+v, want only Q4_0 without a projector", l.Groups)
	}
}

func TestFilesSortedBySizeThenQuant(t *testing.T) {
	f := newFakeHF(t, fakeRepo(
		gguf("m-Q8_0.gguf", 30),
		gguf("m-Q5_0.gguf", 10),
		gguf("m-Q4_0.gguf", 10),
		gguf("m-Q2_K.gguf", 5),
		gguf("README.md", 5),
		`{"type":"directory","path":"BF16.gguf","size":0}`,
	))
	l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Q2_K", "Q4_0", "Q5_0", "Q8_0"}; !slices.Equal(quants(l), want) {
		t.Fatalf("quants = %v, want %v", quants(l), want)
	}
}

func TestFilesFitAtTheEdges(t *testing.T) {
	const gib = 1 << 30
	// 90 % of 12 GiB is 11596411699.2 bytes; the group gets 1.5 GiB on top.
	fitsEdge := int64(12*gib*9/10 - 3*gib/2)
	slowerEdge := int64(12*gib + 32*gib/2 - 3*gib/2) // the GPU plus half the RAM
	cases := []struct {
		size int64
		want string
	}{
		{fitsEdge, catalog.FitFits},
		{fitsEdge + 1, catalog.FitSlower},
		{slowerEdge, catalog.FitSlower},
		{slowerEdge + 1, catalog.FitTooBig},
	}
	for _, tc := range cases {
		t.Run(strconv.FormatInt(tc.size, 10), func(t *testing.T) {
			f := newFakeHF(t, fakeRepo(gguf("m-Q4_0.gguf", tc.size)))
			l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
			if err != nil {
				t.Fatal(err)
			}
			if got := l.Groups[0].Fit; got != tc.want {
				t.Fatalf("fit = %q, want %q", got, tc.want)
			}
		})
	}
}

func writeSized(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFilesInstalledNeedsEveryFileAtFullSize(t *testing.T) {
	dir := t.TempDir()
	f := newFakeHF(t, fakeRepo(gguf("sub/m-Q4_0.gguf", 10), gguf("mmproj-F16.gguf", 4), gguf("m-Q8_0.gguf", 20)))
	c := f.filesClient(t, dir)
	folder := Folder(dir, "o/m", "Q4_0")
	if folder != filepath.Join(dir, "hf", "o", "m", "Q4_0") {
		t.Fatalf("Folder = %q", folder)
	}
	writeSized(t, filepath.Join(folder, "m-Q4_0.gguf"), 10)
	writeSized(t, filepath.Join(folder, "mmproj-F16.gguf"), 3) // one byte short

	l, err := c.Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if group(t, l, "Q4_0").Installed {
		t.Fatal("installed with a short projector")
	}
	writeSized(t, filepath.Join(folder, "mmproj-F16.gguf"), 4)
	if l, _ = c.Files(context.Background(), "o", "m"); !group(t, l, "Q4_0").Installed || group(t, l, "Q8_0").Installed {
		t.Fatalf("installed = %v, %v; want true, false", group(t, l, "Q4_0").Installed, group(t, l, "Q8_0").Installed)
	}
}

func TestFilesDiskFree(t *testing.T) {
	f := newFakeHF(t, fakeRepo(gguf("m-Q4_0.gguf", 10)))
	l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if l.DiskFreeBytes != nil || l.Groups[0].Installed {
		t.Fatalf("no models folder: diskFreeBytes = %v, installed = %v", l.DiskFreeBytes, l.Groups[0].Installed)
	}
	if l, _ = f.filesClient(t, t.TempDir()).Files(context.Background(), "o", "m"); l.DiskFreeBytes == nil || *l.DiskFreeBytes != 77 {
		t.Fatalf("diskFreeBytes = %v, want 77", l.DiskFreeBytes)
	}
}

func TestFilesRepoErrors(t *testing.T) {
	info := func(old, new string) http.HandlerFunc { return serveBody(strings.Replace(testRepoInfo, old, new, 1)) }
	cases := []struct {
		name string
		info http.HandlerFunc
		want error
	}{
		{"401", serveStatus(http.StatusUnauthorized), ErrRepoNotFound},
		{"404", serveStatus(http.StatusNotFound), ErrRepoNotFound},
		{"private", info(`"private":false`, `"private":true`), ErrRepoNotFound},
		{"gated auto", info(`"gated":false`, `"gated":"auto"`), ErrGated},
		{"short sha", info(testSHA, testSHA[:12]), ErrBadAnswer},
		{"503", serveStatus(http.StatusServiceUnavailable), ErrUnreachable},
		{"400", serveStatus(http.StatusBadRequest), ErrBadAnswer},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			routes := fakeRepo(gguf("m-Q4_0.gguf", 10))
			routes["/api/models/o/m"] = tc.info
			_, err := newFakeHF(t, routes).filesClient(t, "").Files(context.Background(), "o", "m")
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// pagedTree serves the tree in pages of one entry, each linking to the next through next(page).
func pagedTree(pages int, next func(page int) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
		if page+1 < pages {
			w.Header().Set("Link", `<`+next(page+1)+`>; rel="next"`)
		}
		_, _ = w.Write([]byte("[" + gguf("m-Q"+strconv.Itoa(page%10)+"_"+strconv.Itoa(page/10)+".gguf", int64(page+1)) + "]"))
	}
}

func TestFilesFollowsNextPagesOnTheSameHost(t *testing.T) {
	treePath := "/api/models/o/m/tree/" + testSHA
	routes := fakeRepo()
	f := newFakeHF(t, routes)
	routes[treePath] = pagedTree(3, func(p int) string { return f.srv.URL + treePath + "?recursive=true&cursor=" + strconv.Itoa(p) })
	l, err := f.filesClient(t, "").Files(context.Background(), "o", "m")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Q0_0", "Q1_0", "Q2_0"}; !slices.Equal(quants(l), want) {
		t.Fatalf("quants = %v, want %v", quants(l), want)
	}

	routes[treePath] = pagedTree(21, func(p int) string { return treePath + "?cursor=" + strconv.Itoa(p) })
	if _, err := f.filesClient(t, "").Files(context.Background(), "o", "m"); !errors.Is(err, ErrBadAnswer) {
		t.Fatalf("21 pages: err = %v, want ErrBadAnswer", err)
	}
}

func TestFilesRefusesANextPageOnAnotherHost(t *testing.T) {
	other := newFakeHF(t, nil)
	routes := fakeRepo()
	routes["/api/models/o/m/tree/"+testSHA] = pagedTree(2, func(p int) string { return other.srv.URL + "/page" })
	_, err := newFakeHF(t, routes).filesClient(t, "").Files(context.Background(), "o", "m")
	if !errors.Is(err, ErrBadAnswer) {
		t.Fatalf("err = %v, want ErrBadAnswer", err)
	}
	if n := len(other.requests()); n != 0 {
		t.Fatalf("the other host got %d requests", n)
	}
}

func TestFilesUnsafeRepoSendsNothing(t *testing.T) {
	f := newFakeHF(t, fakeRepo())
	c := f.filesClient(t, "")
	for _, repo := range [][2]string{{"..", "m"}, {"o", "."}, {"o", "a b"}, {"o/x", "m"}} {
		if _, err := c.Files(context.Background(), repo[0], repo[1]); !errors.Is(err, ErrRepoNotFound) {
			t.Errorf("Files(%q, %q) = %v, want ErrRepoNotFound", repo[0], repo[1], err)
		}
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("sent %d requests", n)
	}
}
