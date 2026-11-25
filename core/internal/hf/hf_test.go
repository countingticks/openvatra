package hf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/hw"
)

// fakeHF plays huggingface.co on loopback: each route answers one URL path, and every request is recorded.
type fakeHF struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seen []*http.Request
}

// newFakeHF starts the server; requests are cloned, as a request is no longer usable once its handler returns.
func newFakeHF(t *testing.T, routes map[string]http.HandlerFunc) *fakeHF {
	t.Helper()
	f := &fakeHF{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.seen = append(f.seen, r.Clone(context.Background()))
		f.mu.Unlock()
		if h, ok := routes[r.URL.Path]; ok {
			h(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// client is a Client on this server; cfg's BaseURL and Version are set here. Its rate limit never runs out, so
// tests that are not about the limit never wait.
func (f *fakeHF) client(t *testing.T, cfg Config) *Client {
	t.Helper()
	c, _ := f.limitedClient(t, cfg, nil)
	c.limit.burst, c.limit.tokens = 1e9, 1e9
	return c
}

// limitedClient is a Client on this server with the real rate limit. With a clock, the bucket reads it and its
// sleep records each wait in the returned slice and moves the clock by it instead of waiting.
func (f *fakeHF) limitedClient(t *testing.T, cfg Config, clock *fakeClock) (*Client, *[]time.Duration) {
	t.Helper()
	cfg.BaseURL, cfg.Version = f.srv.URL, "test"
	if clock != nil {
		cfg.Now = clock.now
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	waits := &[]time.Duration{}
	if clock != nil {
		var mu sync.Mutex
		c.limit.sleep = func(_ context.Context, d time.Duration) error {
			mu.Lock()
			defer mu.Unlock()
			*waits = append(*waits, d)
			clock.t = clock.t.Add(d)
			return nil
		}
	}
	return c, waits
}

func (f *fakeHF) requests() []*http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.seen)
}

// serveFile answers with testdata/<name>.
func serveFile(t *testing.T, name string) http.HandlerFunc {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return serveBody(string(data))
}

func serveBody(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

func serveStatus(code int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", code) }
}

// recordedRepo serves testdata/info-<slug>.json and tree-<slug>.json at the paths Files asks; it returns the repo id.
func recordedRepo(t *testing.T, routes map[string]http.HandlerFunc, slug string) (owner, name string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "info-"+slug+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var info struct{ ID, SHA string }
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	routes["/api/models/"+info.ID] = serveBody(string(data))
	routes["/api/models/"+info.ID+"/tree/"+info.SHA] = serveFile(t, "tree-"+slug+".json")
	owner, name, _ = strings.Cut(info.ID, "/")
	return owner, name
}

const testSHA = "0123456789abcdef0123456789abcdef01234567"

// testRepoInfo is o/m's info at testSHA; tests replace a field to try each rule.
const testRepoInfo = `{"id":"o/m","sha":"` + testSHA + `","gated":false,"private":false,"tags":["gguf"]}`

// fakeRepo serves o/m with these tree entries (see gguf).
func fakeRepo(entries ...string) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"/api/models/o/m":                 serveBody(testRepoInfo),
		"/api/models/o/m/tree/" + testSHA: serveBody("[" + strings.Join(entries, ",") + "]"),
	}
}

// gguf is a tree entry for an LFS file with a valid sha256.
func gguf(path string, size int64) string {
	return fmt.Sprintf(`{"type":"file","path":%q,"size":%d,"lfs":{"oid":"%s","size":%d}}`, path, size, strings.Repeat("ab", 32), size)
}

// testPC has a 12 GiB GPU and 32 GiB of RAM.
func testPC() hw.Report {
	return hw.Report{GPU: &hw.GPU{Name: "GPU", TotalBytes: 12 << 30}, RAMBytes: 32 << 30}
}

// filesClient is a Client on f for Files: testPC, modelsDir dir, and 77 bytes free on every drive.
func (f *fakeHF) filesClient(t *testing.T, dir string) *Client {
	return f.client(t, Config{
		Hardware:  testPC,
		ModelsDir: func() string { return dir },
		DiskFree:  func(string) (uint64, error) { return 77, nil },
	})
}

func TestSearchRecordedAnswer(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveFile(t, "search-qwen-coder.json")})
	repos, err := f.client(t, Config{}).Search(context.Background(), "qwen coder")
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		owner, name      string
		downloads, likes int64
		updated          string
		tags             []string
	}{
		{"DavidAU", "Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF", 1833410, 4286, "2026-11-24T04:17:40Z", []string{"Code"}},
		{"ISTA-DASLab", "Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF", 927903, 682, "2026-10-19T17:48:41Z", []string{"Code", "MoE"}},
		{"nerkyor", "Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-MTP-DFlash2", 883302, 592, "2026-11-15T13:32:17Z", []string{"Code"}},
		{"ccore", "Qwen3.5-4B-3D-Coder", 601055, 1191, "2026-11-06T01:12:46Z", []string{"Code"}},
		{"Qwen", "Qwen2.5-Coder-7B-Instruct-GGUF", 488939, 681, "2024-11-12T07:59:32Z", []string{"Code"}},
		{"unsloth", "Qwen3-Coder-30B-A3B-Instruct-GGUF", 465424, 1240, "2026-01-30T06:29:38Z", []string{"Code", "MoE"}},
		{"llmfan46", "Qwen3-Coder-Next-Uncensored-Heretic-GGUF", 251907, 5, "2026-08-30T05:27:30Z", []string{"Code"}},
		{"unsloth", "Qwen3-Coder-Next-GGUF", 217562, 905, "2026-03-06T14:38:33Z", []string{"Code"}},
	}
	if len(repos) != len(want) {
		t.Fatalf("%d repos, want %d", len(repos), len(want))
	}
	for i, w := range want {
		r := repos[i]
		if r.ID != w.owner+"/"+w.name || r.Owner != w.owner || r.Name != w.name || r.Downloads != w.downloads ||
			r.Likes != w.likes || r.UpdatedAt.UTC().Format(time.RFC3339) != w.updated || !slices.Equal(r.Tags, w.tags) {
			t.Errorf("repo %d = %+v, want %+v", i, r, w)
		}
	}
}

func TestSearchRequestCarriesEveryParameter(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	if _, err := f.client(t, Config{}).Search(context.Background(), "qwen coder"); err != nil {
		t.Fatal(err)
	}
	q := f.requests()[0].URL.Query()
	for key, want := range map[string]string{
		"search": "qwen coder", "filter": "gguf", "sort": "downloads", "direction": "-1", "limit": "30",
	} {
		if got := q.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if got, want := q["expand[]"], []string{"downloads", "likes", "lastModified", "tags", "pipeline_tag"}; !slices.Equal(got, want) {
		t.Errorf("expand[] = %v, want %v", got, want)
	}
}

func TestSearchSendsNoIdentityAlsoAfterARedirect(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{
		"/api/models": func(w http.ResponseWriter, r *http.Request) {
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "x"})
			http.Redirect(w, r, "/moved?"+r.URL.RawQuery, http.StatusFound)
		},
		"/moved": serveBody("[]"),
	})
	if _, err := f.client(t, Config{}).Search(context.Background(), "qwen"); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 2 || reqs[1].URL.Path != "/moved" {
		t.Fatalf("requests = %d, want the redirect followed", len(reqs))
	}
	for _, r := range reqs {
		if got := r.Header.Get("User-Agent"); got != "OpenVatra/test" {
			t.Errorf("%s: User-Agent = %q", r.URL.Path, got)
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("%s: sent Authorization %q, Cookie %q", r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Cookie"))
		}
	}
}

func TestSearchRefusesARedirectToAnotherHost(t *testing.T) {
	other := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	f := newFakeHF(t, map[string]http.HandlerFunc{
		"/api/models": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.srv.URL+"/api/models", http.StatusFound)
		},
	})
	_, err := f.client(t, Config{}).Search(context.Background(), "qwen")
	if !errors.Is(err, ErrBadAnswer) {
		t.Fatalf("err = %v, want ErrBadAnswer", err)
	}
	if n := len(other.requests()); n != 0 {
		t.Fatalf("the other host got %d requests", n)
	}
}

func TestSearchLeavesOutNonGGUFAndUnsafeIDs(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody(`[
		{"id":"a/kept","tags":["gguf"]},
		{"id":"a/no-gguf","tags":["safetensors"]},
		{"id":"a/..","tags":["gguf"]},
		{"id":"a b/c","tags":["gguf"]},
		{"id":"no-owner","tags":["gguf"]}
	]`)})
	repos, err := f.client(t, Config{}).Search(context.Background(), "qwen")
	if err != nil {
		t.Fatal(err)
	}
	if len(repos) != 1 || repos[0].ID != "a/kept" || repos[0].Tags == nil {
		t.Fatalf("repos = %+v, want only a/kept with tags []", repos)
	}
}

func TestSearchTags(t *testing.T) {
	cases := []struct {
		name, model string
		want        []string
	}{
		{"MoE from A3B in the name", `{"id":"o/Qwen3-30B-A3B-GGUF","tags":["gguf"]}`, []string{"MoE"}},
		{"MoE from a moe tag", `{"id":"o/Mixer-GGUF","tags":["gguf","moe"]}`, []string{"MoE"}},
		{"Embeddings from feature-extraction", `{"id":"o/embed-GGUF","tags":["gguf"],"pipeline_tag":"feature-extraction"}`, []string{"Embeddings"}},
		{"Code from Coder", `{"id":"o/Qwen2.5-Coder-7B-GGUF","tags":["gguf"]}`, []string{"Code"}},
		{"none", `{"id":"o/Qwen3-8B-GGUF","tags":["gguf"],"pipeline_tag":"text-generation"}`, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[" + tc.model + "]")})
			repos, err := f.client(t, Config{}).Search(context.Background(), "qwen")
			if err != nil {
				t.Fatal(err)
			}
			if len(repos) != 1 || !slices.Equal(repos[0].Tags, tc.want) {
				t.Fatalf("repos = %+v, want tags %v", repos, tc.want)
			}
		})
	}
}

func TestSearchQueryLength(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	c := f.client(t, Config{})
	for _, q := range []string{"q", strings.Repeat("q", 101), "   "} {
		if _, err := c.Search(context.Background(), q); !errors.Is(err, ErrBadQuery) {
			t.Errorf("Search(%d chars) = %v, want ErrBadQuery", len(q), err)
		}
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("a bad query sent %d requests", n)
	}
	if _, err := c.Search(context.Background(), "  qw  "); err != nil {
		t.Fatal(err)
	}
	if got := f.requests()[0].URL.Query().Get("search"); got != "qw" {
		t.Fatalf("search = %q, want qw", got)
	}
}

func TestSearchUnreachable(t *testing.T) {
	slow := func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }
	cases := map[string]http.HandlerFunc{
		"slower than the timeout": slow,
		"503":                     serveStatus(http.StatusServiceUnavailable),
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": h})
			_, err := f.client(t, Config{Timeout: 50 * time.Millisecond}).Search(context.Background(), "qwen")
			if !errors.Is(err, ErrUnreachable) {
				t.Fatalf("err = %v, want ErrUnreachable", err)
			}
		})
	}
}

func TestSearchBadAnswer(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"400":            serveStatus(http.StatusBadRequest),
		"malformed JSON": serveBody(`[{"id":`),
		"a 9 MiB body":   serveBody(`["` + strings.Repeat("x", 9<<20) + `"]`),
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": h})
			_, err := f.client(t, Config{}).Search(context.Background(), "qwen")
			if !errors.Is(err, ErrBadAnswer) {
				t.Fatalf("err = %v, want ErrBadAnswer", err)
			}
		})
	}
}

func TestNewRefusesANonLoopbackBase(t *testing.T) {
	for _, base := range []string{"https://example.com", "http://10.0.0.1:80", "http://127.0.0.1:1/path"} {
		if _, err := New(Config{BaseURL: base}); !errors.Is(err, ErrBadBase) {
			t.Errorf("New(%q) = %v, want ErrBadBase", base, err)
		}
	}
	for _, base := range []string{"", "http://127.0.0.1:8123", "http://localhost:8123"} {
		if _, err := New(Config{BaseURL: base}); err != nil {
			t.Errorf("New(%q) = %v", base, err)
		}
	}
}
