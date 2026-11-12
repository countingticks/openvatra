package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/countingticks/openvatra/core/internal/downloads"
)

// stubDownloads records calls and answers with err.
type stubDownloads struct {
	mu      sync.Mutex
	calls   []string
	err     error
	items   []downloads.DownloadItem
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
func (s *stubDownloads) Items() []downloads.DownloadItem {
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
	testHandler(Deps{Downloads: dl}).ServeHTTP(rec, req)
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

func TestListDownloads(t *testing.T) {
	if rec := callDownloads(&stubDownloads{}, "GET", "/api/downloads", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"items":[]}` {
		t.Fatalf("empty queue: %d %s", rec.Code, rec.Body)
	}
	dl := &stubDownloads{items: []downloads.DownloadItem{{ID: "qwen", State: downloads.Downloading, Bytes: 5, Total: 10}}}
	rec := callDownloads(dl, "GET", "/api/downloads", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `{"items":[{"id":"qwen","state":"downloading"`) {
		t.Fatalf("one item: %d %s", rec.Code, rec.Body)
	}
}

func TestStartErrorCodes(t *testing.T) {
	cases := []struct{ body, code string }{
		{`{"engine":"vulkan"}`, "invalid_request"},
		{`{"catalogId":"a","x":1}`, "invalid_request"},
		{`{"catalogId":"a","engine":"cuda"}`, "bad_request"},
		{`{}`, "bad_request"},
	}
	for _, c := range cases {
		rec := callDownloads(&stubDownloads{}, "POST", "/api/downloads", c.body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"error":"`+c.code+`"`) {
			t.Errorf("body %s -> %d %s, want 400 %s", c.body, rec.Code, rec.Body, c.code)
		}
	}
}

func TestStartAcceptsBodiesUpTo1MiB(t *testing.T) {
	dl := &stubDownloads{}
	body := `{"catalogId":"qwen"` + strings.Repeat(" ", 4<<10) + `}`
	if rec := callDownloads(dl, "POST", "/api/downloads", body); rec.Code != http.StatusAccepted {
		t.Fatalf("a 4 KiB body: %d %s", rec.Code, rec.Body)
	}
}
