package hf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// hits is n search hits o/m<from>…o/m<from+n-1>, each with one sibling m<i>-Q4_K_M.gguf, or none when quants is 0.
func hits(from, n, quants int) []string {
	out := make([]string, n)
	for i := range n {
		id := from + i
		siblings := ""
		if quants > 0 {
			siblings = fmt.Sprintf(`{"rfilename":"m%d-Q4_K_M.gguf"}`, id)
		}
		out[i] = fmt.Sprintf(`{"id":"o/m%d","tags":["gguf"],"siblings":[%s]}`, id, siblings)
	}
	return out
}

// servePages answers Hugging Face page k (the cursor query; none is 0) with page(k), and links to page k+1 while
// k < last; last < 0 links on forever.
func servePages(last int, page func(k int) []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		k, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
		if last < 0 || k < last {
			w.Header().Set("Link", fmt.Sprintf(`<http://%s/api/models?cursor=%d>; rel="next"`, r.Host, k+1))
		}
		serveBody("["+strings.Join(page(k), ",")+"]")(w, r)
	}
}

// ids are the answer's repo IDs.
func ids(p SearchPage) []string {
	out := make([]string, len(p.Repos))
	for i, r := range p.Repos {
		out[i] = r.ID
	}
	return out
}

// wantIDs is o/m<from>…o/m<to>.
func wantIDs(from, to int) []string {
	out := []string{}
	for i := from; i <= to; i++ {
		out = append(out, fmt.Sprintf("o/m%d", i))
	}
	return out
}

func searchPage(t *testing.T, c *Client, q string, page int) SearchPage {
	t.Helper()
	p, err := c.Search(context.Background(), q, page)
	if err != nil {
		t.Fatalf("page %d: %v", page, err)
	}
	return p
}

func TestSearchRecordedAnswerPagesAndQuants(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveFile(t, "search-qwen-coder.json")})
	c := f.client(t, Config{})
	first := searchPage(t, c, "qwen coder", 0)

	data, err := os.ReadFile(filepath.Join("testdata", "search-qwen-coder.json"))
	if err != nil {
		t.Fatal(err)
	}
	var recorded []struct {
		ID       string
		Siblings []struct{ RFilename string }
	}
	if err := json.Unmarshal(data, &recorded); err != nil {
		t.Fatal(err)
	}
	if len(recorded) != 12 {
		t.Fatalf("the fixture has %d repos, want 12", len(recorded))
	}
	recordedIDs := make([]string, len(recorded))
	for i, r := range recorded {
		recordedIDs[i] = r.ID
	}
	if !slices.Equal(ids(first), recordedIDs[:10]) || !first.HasMore {
		t.Fatalf("page 0 = %v (hasMore %v), want the first 10 in order", ids(first), first.HasMore)
	}

	// Files on a tree of the same names (size 1, a valid sha) lists as many groups as search counted.
	for i, r := range first.Repos {
		entries := []string{}
		for _, s := range recorded[i].Siblings {
			entries = append(entries, gguf(s.RFilename, 1))
		}
		repo := newFakeHF(t, fakeRepo(entries...))
		l, err := repo.filesClient(t, t.TempDir()).Files(context.Background(), "o", "m")
		if err != nil {
			t.Fatal(err)
		}
		if r.Quants != len(l.Groups) || r.Quants < 1 {
			t.Errorf("%s: quants = %d, Files lists %d", r.ID, r.Quants, len(l.Groups))
		}
	}
	if r := first.Repos[1]; r.ID != "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF" || r.Quants != 1 {
		t.Fatalf("repo 1 = %s with %d quants, want ISTA-DASLab's with 1", r.ID, r.Quants)
	}

	second := searchPage(t, c, "qwen coder", 1)
	if !slices.Equal(ids(second), recordedIDs[10:]) || second.HasMore || second.Page != 1 {
		t.Fatalf("page 1 = %v (hasMore %v), want the last 2", ids(second), second.HasMore)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("%d requests, want 1", n)
	}
}

func TestSearchQuantCount(t *testing.T) {
	cases := []struct {
		name  string
		names []string
		want  int
	}{
		{"split parts count once", []string{"m-Q4_K_M-00001-of-00002.gguf", "m-Q4_K_M-00002-of-00002.gguf"}, 1},
		{"a split group missing a part counts 0", []string{"m-Q4_K_M-00001-of-00003.gguf", "m-Q4_K_M-00002-of-00003.gguf"}, 0},
		{"projectors count 0", []string{"mmproj-F16.gguf", "sub/MMPROJ-m-BF16.gguf"}, 0},
		{"the same quant in two folders counts 2", []string{"a/x-Q4_K_M.gguf", "b/y-Q4_K_M.gguf"}, 2},
		{"an unsafe segment counts 0", []string{"bad dir/m-Q4_K_M.gguf", "../m-Q5_K_M.gguf"}, 0},
		{"other files count 0", []string{".gitattributes", "README.md"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := quantCount(tc.names); got != tc.want {
				t.Fatalf("quantCount(%v) = %d, want %d", tc.names, got, tc.want)
			}
		})
	}
}

func TestSearchDropsReposWithoutQuantsAndRepeats(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": servePages(1, func(k int) []string {
		if k == 0 {
			return append(hits(1, 1, 1), hits(2, 1, 0)...)
		}
		return append(hits(1, 1, 1), hits(3, 1, 1)...)
	})})
	p := searchPage(t, f.client(t, Config{}), "qwen", 0)
	if want := []string{"o/m1", "o/m3"}; !slices.Equal(ids(p), want) {
		t.Fatalf("repos = %v, want %v", ids(p), want)
	}
	if p.Repos[0].Quants != 1 {
		t.Fatalf("quants = %d, want 1", p.Repos[0].Quants)
	}
}

func TestSearchReadsOnOnlyAsFarAsAPageNeeds(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": servePages(2, func(k int) []string {
		return hits(1+50*k, 50, 1)
	})})
	c := f.client(t, Config{})

	p := searchPage(t, c, "qwen", 0)
	if !slices.Equal(ids(p), wantIDs(1, 10)) || !p.HasMore || len(f.requests()) != 1 {
		t.Fatalf("page 0 = %v (hasMore %v) after %d requests", ids(p), p.HasMore, len(f.requests()))
	}
	p = searchPage(t, c, "qwen", 1)
	if !slices.Equal(ids(p), wantIDs(11, 20)) || !p.HasMore || len(f.requests()) != 1 {
		t.Fatalf("page 1 = %v (hasMore %v) after %d requests", ids(p), p.HasMore, len(f.requests()))
	}
	p = searchPage(t, c, "qwen", 9)
	if !slices.Equal(ids(p), wantIDs(91, 100)) || p.HasMore {
		t.Fatalf("page 9 = %v (hasMore %v)", ids(p), p.HasMore)
	}
	reqs := f.requests()
	if len(reqs) != 2 || reqs[1].URL.Query().Get("cursor") != "1" {
		t.Fatalf("%d requests, want the second page only", len(reqs))
	}
}

func TestSearchShortLastPage(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": servePages(0, func(int) []string { return hits(1, 15, 1) })})
	c := f.client(t, Config{})
	p := searchPage(t, c, "qwen", 1)
	if !slices.Equal(ids(p), wantIDs(11, 15)) || p.HasMore {
		t.Fatalf("page 1 = %v (hasMore %v)", ids(p), p.HasMore)
	}
	p = searchPage(t, c, "qwen", 2)
	if p.Repos == nil || len(p.Repos) != 0 || p.HasMore || p.Page != 2 {
		t.Fatalf("page 2 = %+v, want [] and no more", p)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("%d requests, want 1", n)
	}
}

func TestSearchStopsAfterTenRequests(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": servePages(-1, func(k int) []string {
		return hits(1+50*k, 50, 0)
	})})
	c := f.client(t, Config{})
	for range 2 {
		p := searchPage(t, c, "qwen", 0)
		if len(p.Repos) != 0 || p.HasMore {
			t.Fatalf("page 0 = %+v, want [] and no more", p)
		}
		if n := len(f.requests()); n != 10 {
			t.Fatalf("%d requests, want 10", n)
		}
	}
}

func TestSearchBadPageAndQuerySendNothing(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	c := f.client(t, Config{})
	for _, page := range []int{-1, 10} {
		if _, err := c.Search(context.Background(), "qwen", page); !errors.Is(err, ErrBadPage) {
			t.Errorf("page %d: %v, want ErrBadPage", page, err)
		}
	}
	if _, err := c.Search(context.Background(), "a", 0); !errors.Is(err, ErrBadQuery) {
		t.Errorf("q \"a\": %v, want ErrBadQuery", err)
	}
	if _, err := c.Search(context.Background(), "a", 10); !errors.Is(err, ErrBadQuery) {
		t.Errorf("q \"a\" on page 10: %v, want ErrBadQuery first", err)
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("%d requests, want none", n)
	}
}

func TestSearchKeepsProgressBeforeAFailure(t *testing.T) {
	var secondPageCalls atomic.Int32
	pages := servePages(1, func(k int) []string { return hits(1+5*k, 5, 1) })
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "1" && secondPageCalls.Add(1) == 1 {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		pages(w, r)
	}})
	c := f.client(t, Config{})
	if _, err := c.Search(context.Background(), "qwen", 0); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("err = %v, want ErrUnreachable", err)
	}
	p := searchPage(t, c, "qwen", 0)
	if !slices.Equal(ids(p), wantIDs(1, 10)) {
		t.Fatalf("page 0 = %v", ids(p))
	}
	reqs := f.requests()
	if len(reqs) != 3 || reqs[2].URL.Query().Get("cursor") != "1" {
		t.Fatalf("%d requests, want the retry to ask only the second page", len(reqs))
	}
}

func TestSearchConcurrentCallsSendOneRequest(t *testing.T) {
	release := make(chan struct{})
	pages := servePages(0, func(int) []string { return hits(1, 3, 1) })
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": func(w http.ResponseWriter, r *http.Request) {
		<-release
		pages(w, r)
	}})
	c := f.client(t, Config{})
	type result struct {
		p   SearchPage
		err error
	}
	a, b := make(chan result, 1), make(chan result, 1)
	go func() { p, err := c.Search(context.Background(), "qwen", 0); a <- result{p, err} }()
	waitFor(t, func() bool { return len(f.requests()) == 1 })
	go func() { p, err := c.Search(context.Background(), "Qwen", 0); b <- result{p, err} }()
	close(release)
	ra, rb := <-a, <-b
	if ra.err != nil || rb.err != nil || !reflect.DeepEqual(ra.p, rb.p) || len(ra.p.Repos) != 3 {
		t.Fatalf("A = %+v, %v; B = %+v, %v", ra.p, ra.err, rb.p, rb.err)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("%d requests, want 1", n)
	}
}

func TestSearchRefusesANextPageOnAnotherHost(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Link", `<http://example.com/api/models?cursor=1>; rel="next"`)
		serveBody("["+strings.Join(hits(1, 5, 1), ",")+"]")(w, r)
	}})
	if _, err := f.client(t, Config{}).Search(context.Background(), "qwen", 0); !errors.Is(err, ErrBadAnswer) {
		t.Fatalf("err = %v, want ErrBadAnswer", err)
	}
}
