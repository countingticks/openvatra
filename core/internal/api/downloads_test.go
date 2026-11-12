package api

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/downloads"
)

// stubDownloads records calls and answers with err.
type stubDownloads struct {
	mu      sync.Mutex
	calls   []string
	err     error
	items   []downloads.Item
	changes chan struct{}
}

func (s *stubDownloads) record(c string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, c)
	return s.err
}
func (s *stubDownloads) Start(id string) error  { return s.record("start " + id) }
func (s *stubDownloads) StartEngine() error     { return s.record("start engine") }
func (s *stubDownloads) Resume(id string) error { return s.record("resume " + id) }
func (s *stubDownloads) Cancel(id string) error { return s.record("cancel " + id) }
func (s *stubDownloads) Items() []downloads.Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items
}
func (s *stubDownloads) Subscribe() (<-chan struct{}, func()) { return s.changes, func() {} }

func callDownloads(dl Downloads, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	NewHandler(testToken, testPort, func() {}, nil, nil, config.NewOverride(), stubHardware{}, stubCatalog{}, dl, nil).ServeHTTP(rec, req)
	return rec
}

func TestDownloadEndpointsCallTheQueue(t *testing.T) {
	dl := &stubDownloads{}
	cases := []struct{ method, path, body, call string }{
		{"POST", "/api/downloads", `{"catalogId":"qwen"}`, "start qwen"},
		{"POST", "/api/downloads", `{"engine":"cuda"}`, "start engine"},
		{"DELETE", "/api/downloads/qwen", "", "cancel qwen"},
		{"POST", "/api/downloads/qwen/resume", "", "resume qwen"},
	}
	for _, c := range cases {
		if rec := callDownloads(dl, c.method, c.path, c.body); rec.Code != http.StatusAccepted {
			t.Fatalf("%s %s = %d %s", c.method, c.path, rec.Code, rec.Body)
		}
		if got := dl.calls[len(dl.calls)-1]; got != c.call {
			t.Fatalf("queue got %q, want %q", got, c.call)
		}
	}
}

func TestDownloadErrorsMapToStatuses(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{downloads.ErrUnknown, 404, "unknown_model"},
		{downloads.ErrNoDownload, 404, "no_download"},
		{downloads.ErrInstalled, 409, "already_installed"},
		{downloads.ErrNoSpace, 409, "not_enough_space"},
		{downloads.ErrNoFolder, 409, "no_models_folder"},
		{downloads.ErrNotResumable, 409, "not_paused"},
	}
	for _, c := range cases {
		rec := callDownloads(&stubDownloads{err: c.err}, "POST", "/api/downloads", `{"catalogId":"qwen"}`)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.code) {
			t.Fatalf("%v -> %d %s, want %d %s", c.err, rec.Code, rec.Body, c.status, c.code)
		}
	}
}

func TestStartRejectsBadBodies(t *testing.T) {
	for _, body := range []string{``, `{}`, `{"catalogId":"a","engine":"cuda"}`, `{"catalogId":"a","x":1}`, `{"engine":"rocm"}`, `nope`} {
		dl := &stubDownloads{}
		if rec := callDownloads(dl, "POST", "/api/downloads", body); rec.Code != http.StatusBadRequest || len(dl.calls) != 0 {
			t.Fatalf("body %q -> %d, calls %v", body, rec.Code, dl.calls)
		}
	}
}

func TestEventsSendDownloadsAndThrottleThem(t *testing.T) {
	dl := &stubDownloads{changes: make(chan struct{}, 1), items: []downloads.Item{{ID: "qwen", State: downloads.Downloading, Bytes: 1, Total: 2}}}
	srv := httptest.NewServer(eventsHandler(&stubRouter{changes: make(chan struct{}, 1)}, twoModels, dl))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Read event names and the time each "downloads" event arrived.
	arrivals := make(chan time.Time, 20)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			if sc.Text() == "event: downloads" {
				arrivals <- time.Now()
			}
		}
	}()
	first := waitArrival(t, arrivals)

	// A burst of 20 changes must collapse into a few events, not 20.
	for i := 0; i < 20; i++ {
		select {
		case dl.changes <- struct{}{}:
		default:
		}
		time.Sleep(5 * time.Millisecond)
	}
	second := waitArrival(t, arrivals)
	if second.Sub(first) < downloadsInterval-20*time.Millisecond {
		t.Fatalf("events %v apart, want at least %v", second.Sub(first), downloadsInterval)
	}
	time.Sleep(downloadsInterval + 100*time.Millisecond)
	if n := len(arrivals); n > 2 {
		t.Fatalf("%d extra events for one burst", n)
	}
}

func waitArrival(t *testing.T, ch <-chan time.Time) time.Time {
	t.Helper()
	select {
	case at := <-ch:
		return at
	case <-time.After(3 * time.Second):
		t.Fatal("no downloads event")
		return time.Time{}
	}
}
