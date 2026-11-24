package hf

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is the cache's clock; tests move it by hand.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func TestCachedSearchIgnoresCaseUntilTenMinutesPass(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	clock := &fakeClock{t: time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC)}
	c := f.client(t, Config{Now: clock.now})
	for _, q := range []string{"qwen coder", "Qwen Coder"} {
		if _, err := c.Search(context.Background(), q); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("%d requests, want 1", n)
	}
	clock.t = clock.t.Add(10*time.Minute + time.Second)
	if _, err := c.Search(context.Background(), "qwen coder"); err != nil {
		t.Fatal(err)
	}
	if n := len(f.requests()); n != 2 {
		t.Fatalf("%d requests after ten minutes, want 2", n)
	}
}

func TestCachedFilesReadInstalledFresh(t *testing.T) {
	dir := t.TempDir()
	f := newFakeHF(t, fakeRepo(gguf("m-Q4_0.gguf", 10)))
	c := f.filesClient(t, dir)
	l, err := c.Files(context.Background(), "o", "m")
	if err != nil || l.Groups[0].Installed {
		t.Fatalf("first listing: %+v, %v", l, err)
	}
	writeSized(t, filepath.Join(Folder(dir, "o/m", "Q4_0"), "m-Q4_0.gguf"), 10)
	if l, err = c.Files(context.Background(), "o", "m"); err != nil || !l.Groups[0].Installed {
		t.Fatalf("second listing: %+v, %v; want installed", l, err)
	}
	if n := len(f.requests()); n != 2 { // info and tree, once
		t.Fatalf("%d requests, want 2", n)
	}
}

func TestCacheEvictsTheOldestPastFifty(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	c := f.client(t, Config{})
	for i := range 51 {
		if _, err := c.Search(context.Background(), fmt.Sprintf("q%02d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Search(context.Background(), "q50"); err != nil { // still cached
		t.Fatal(err)
	}
	if n := len(f.requests()); n != 51 {
		t.Fatalf("%d requests, want 51", n)
	}
	if _, err := c.Search(context.Background(), "q00"); err != nil { // evicted
		t.Fatal(err)
	}
	if n := len(f.requests()); n != 52 {
		t.Fatalf("%d requests, want 52", n)
	}
}

func TestFailedSearchIsNotCached(t *testing.T) {
	var calls atomic.Int32
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "busy", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("[]"))
	}})
	c := f.client(t, Config{})
	if _, err := c.Search(context.Background(), "qwen"); err == nil {
		t.Fatal("the first search should fail")
	}
	if _, err := c.Search(context.Background(), "qwen"); err != nil {
		t.Fatalf("second search: %v", err)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("%d requests, want 2", n)
	}
}

func TestSearchLogNeverHoldsTheQuery(t *testing.T) {
	const query = "secret-query-text"
	cases := map[string]http.HandlerFunc{
		"success": serveBody(`[{"id":"o/m","tags":["gguf"]}]`),
		// a timeout's url.Error holds the URL, and so the query
		"unreachable": func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() },
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": h})
			c := f.client(t, Config{Logger: slog.New(slog.NewTextHandler(&buf, nil)), Timeout: 50 * time.Millisecond})
			_, _ = c.Search(context.Background(), query)
			log := buf.String()
			if !strings.Contains(log, "hf search") || strings.Contains(log, query) {
				t.Fatalf("log = %q", log)
			}
		})
	}
}
