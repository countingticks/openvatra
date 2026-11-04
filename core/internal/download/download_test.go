package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var payload = []byte(strings.Repeat("openvatra-model-bytes-", 5000))

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// newTestDownloader trusts the test server's certificate and allows any host (the tests for the allowlist
// use the real rule instead).
func newTestDownloader(srv *httptest.Server) *Downloader {
	return &Downloader{
		Client:    srv.Client(),
		AllowHost: func(string) bool { return true },
		Backoff:   []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond},
	}
}

func request(t *testing.T, url string) Request {
	t.Helper()
	return Request{URL: url, Dest: filepath.Join(t.TempDir(), "m.gguf"), Size: int64(len(payload)), SHA256: sum(payload)}
}

// rangeServer serves payload and honours Range, like Hugging Face's CDN.
func rangeServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "m.gguf", time.Time{}, strings.NewReader(string(payload)))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchWholeFile(t *testing.T) {
	srv := rangeServer(t)
	req := request(t, srv.URL)
	var last Progress
	if err := newTestDownloader(srv).Fetch(context.Background(), req, func(p Progress) { last = p }); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(req.Dest)
	if err != nil || string(got) != string(payload) {
		t.Fatalf("final file wrong: %v", err)
	}
	if _, err := os.Stat(req.Dest + ".part"); !os.IsNotExist(err) {
		t.Fatal(".part should be gone after the rename")
	}
	if last.Done != req.Size || last.Total != req.Size {
		t.Fatalf("last progress = %+v", last)
	}
}

func TestFetchResumesWithRange(t *testing.T) {
	var rangeHeader atomic.Value
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeader.Store(r.Header.Get("Range"))
		http.ServeContent(w, r, "m.gguf", time.Time{}, strings.NewReader(string(payload)))
	}))
	defer srv.Close()
	req := request(t, srv.URL)
	if err := os.WriteFile(req.Dest+".part", payload[:1000], 0o644); err != nil {
		t.Fatal(err)
	}
	if err := newTestDownloader(srv).Fetch(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if rangeHeader.Load() != "bytes=1000-" {
		t.Fatalf("Range = %v", rangeHeader.Load())
	}
	if got, _ := os.ReadFile(req.Dest); string(got) != string(payload) {
		t.Fatal("resumed file differs")
	}
}

func TestFetchStartsOverWhenRangeIgnored(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload) // always 200 with the whole body
	}))
	defer srv.Close()
	req := request(t, srv.URL)
	if err := os.WriteFile(req.Dest+".part", payload[:1000], 0o644); err != nil {
		t.Fatal(err)
	}
	if err := newTestDownloader(srv).Fetch(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(req.Dest); string(got) != string(payload) {
		t.Fatal("file should be the full payload, not part + payload")
	}
}

func TestFetchChecksumMismatchDeletesPart(t *testing.T) {
	srv := rangeServer(t)
	req := request(t, srv.URL)
	req.SHA256 = sum([]byte("something else"))
	err := newTestDownloader(srv).Fetch(context.Background(), req, nil)
	if !errors.Is(err, ErrDamaged) {
		t.Fatalf("err = %v, want ErrDamaged", err)
	}
	for _, p := range []string{req.Dest, req.Dest + ".part"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s should not exist", p)
		}
	}
}

func TestFetchRetriesThenPauses(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		// Promise the whole file, send a bit, then drop the connection.
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = w.Write(payload[:500])
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}))
	defer srv.Close()
	req := request(t, srv.URL)
	err := newTestDownloader(srv).Fetch(context.Background(), req, nil)
	if !errors.Is(err, ErrPaused) {
		t.Fatalf("err = %v, want ErrPaused", err)
	}
	if calls.Load() != 4 { // first try + 3 retries
		t.Fatalf("calls = %d, want 4", calls.Load())
	}
	if _, err := os.Stat(req.Dest + ".part"); err != nil {
		t.Fatal(".part must be kept so Resume can continue it")
	}
}

func TestFetchDoesNotRetryNotFound(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	err := newTestDownloader(srv).Fetch(context.Background(), request(t, srv.URL), nil)
	if err == nil || errors.Is(err, ErrPaused) || calls.Load() != 1 {
		t.Fatalf("err = %v, calls = %d", err, calls.Load())
	}
}

func TestFetchRefusesPlainHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer srv.Close()
	err := newTestDownloader(srv).Fetch(context.Background(), request(t, srv.URL), nil)
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("err = %v, want ErrNotAllowed", err)
	}
}

func TestFetchRefusesRedirectToOtherHost(t *testing.T) {
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer other.Close()
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Same machine, different host name: "localhost" is not on the allowlist below.
		http.Redirect(w, r, strings.Replace(other.URL, "127.0.0.1", "localhost", 1), http.StatusFound)
	}))
	defer origin.Close()

	d := newTestDownloader(origin)
	d.AllowHost = func(host string) bool { return host == "127.0.0.1" }
	err := d.Fetch(context.Background(), request(t, origin.URL), nil)
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("err = %v, want ErrNotAllowed", err)
	}
}

func TestHuggingFaceHost(t *testing.T) {
	for host, want := range map[string]bool{
		"huggingface.co":          true,
		"cdn-lfs.hf.co":           true,
		"cas-bridge.xethub.hf.co": true,
		"hf.co":                   true,
		"evilhf.co":               false,
		"huggingface.co.evil.com": false,
		"example.com":             false,
		"":                        false,
	} {
		if got := HuggingFaceHost(host); got != want {
			t.Errorf("HuggingFaceHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestFetchStopsOnCancel(t *testing.T) {
	srv := rangeServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := newTestDownloader(srv).Fetch(ctx, request(t, srv.URL), nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}
