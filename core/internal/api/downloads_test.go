package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/hf"
	"github.com/countingticks/openvatra/core/internal/store"
)

// stubDownloads records calls and answers with err.
type stubDownloads struct {
	mu      sync.Mutex
	calls   []string
	err     error
	items   []downloads.DownloadItem
	changes chan struct{}
	pick    store.HFPick // the last StartPick's
}

func (s *stubDownloads) record(c string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, c)
	return s.err
}
func (s *stubDownloads) Start(id string) error { return s.record("start " + id) }
func (s *stubDownloads) StartEngine() error    { return s.record("start engine") }
func (s *stubDownloads) StartPick(_ context.Context, p store.HFPick) error {
	s.mu.Lock()
	s.pick = p
	s.mu.Unlock()
	return s.record("start pick " + p.ID)
}
func (s *stubDownloads) Resume(id string) error { return s.record("resume " + id) }
func (s *stubDownloads) Pause(id string) error  { return s.record("pause " + id) }
func (s *stubDownloads) Cancel(id string) error { return s.record("cancel " + id) }
func (s *stubDownloads) Items() []downloads.DownloadItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items
}
func (s *stubDownloads) Subscribe() (<-chan struct{}, func()) { return s.changes, func() {} }

func callDownloads(t *testing.T, dl Downloads, method, path, body string) *httptest.ResponseRecorder {
	return callDownloadsHF(t, dl, nil, method, path, body)
}

// callDownloadsHF is callDownloads with a Hugging Face behind the hf start.
func callDownloadsHF(t *testing.T, dl Downloads, h HF, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	testHandler(t, Deps{Downloads: dl, HF: h}).ServeHTTP(rec, req)
	return rec
}

// listedRepo is o/r with one Q4_K_M group: a part in the root and a projector in a subfolder.
func listedRepo() *stubHF {
	return &stubHF{listing: hf.Listing{Repo: "o/r", Revision: strings.Repeat("a", 40), Groups: []hf.Group{
		{Quant: "Q8_0", Files: []hf.GroupFile{{Name: "m-Q8_0.gguf", Path: "m-Q8_0.gguf", SizeBytes: 9, SHA256: "s8"}}},
		{Quant: "Q4_K_M", Files: []hf.GroupFile{
			{Name: "m-Q4_K_M.gguf", Path: "m-Q4_K_M.gguf", SizeBytes: 5, SHA256: "s4"},
			{Name: "mmproj-F16.gguf", Path: "proj/mmproj-F16.gguf", SizeBytes: 2, SHA256: "sp", Projector: true},
		}},
	}}}
}

func TestStartHFChecksASingleFileGroup(t *testing.T) {
	incomplete := "Not a complete model: it holds 1 of 49 layers. It may be a draft file for faster replies; " +
		"download the model's main file instead."
	t.Run("an incomplete file is refused and nothing is queued", func(t *testing.T) {
		dl, h := &stubDownloads{}, listedRepo()
		h.checkText = incomplete
		rec := callDownloadsHF(t, dl, h, "POST", "/api/downloads", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"error":"hf_incomplete_model"`) ||
			!strings.Contains(rec.Body.String(), "it holds 1 of 49 layers") {
			t.Fatalf("start = %d %s", rec.Code, rec.Body)
		}
		if len(dl.calls) != 0 {
			t.Fatalf("calls = %v, want none", dl.calls)
		}
	})
	t.Run("a failing check lets the download start", func(t *testing.T) {
		dl, h := &stubDownloads{}, listedRepo()
		h.checkErr = hf.ErrUnreachable
		rec := callDownloadsHF(t, dl, h, "POST", "/api/downloads", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`)
		if rec.Code != http.StatusAccepted || !slices.Equal(dl.calls, []string{"start pick hf:o/r:Q4_K_M"}) {
			t.Fatalf("start = %d %s, calls %v", rec.Code, rec.Body, dl.calls)
		}
	})
	t.Run("the model file is checked once, not the projector", func(t *testing.T) {
		dl, h := &stubDownloads{}, listedRepo()
		callDownloadsHF(t, dl, h, "POST", "/api/downloads", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`)
		if !slices.Equal(h.checked, []string{"m-Q4_K_M.gguf"}) {
			t.Fatalf("checked %v", h.checked)
		}
	})
	t.Run("an installed group is not checked", func(t *testing.T) {
		dl, h := &stubDownloads{}, listedRepo()
		h.listing.Groups[1].Installed = true
		h.checkText = incomplete
		callDownloadsHF(t, dl, h, "POST", "/api/downloads", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`)
		if len(h.checked) != 0 || !slices.Equal(dl.calls, []string{"start pick hf:o/r:Q4_K_M"}) {
			t.Fatalf("checked %v, calls %v", h.checked, dl.calls)
		}
	})
	t.Run("a split group is not checked", func(t *testing.T) {
		dl, h := &stubDownloads{}, listedRepo()
		h.listing.Groups = append(h.listing.Groups, hf.Group{Quant: "BF16", Files: []hf.GroupFile{
			{Name: "m-BF16-00001-of-00002.gguf", Path: "BF16/m-BF16-00001-of-00002.gguf", SizeBytes: 5, SHA256: "a"},
			{Name: "m-BF16-00002-of-00002.gguf", Path: "BF16/m-BF16-00002-of-00002.gguf", SizeBytes: 5, SHA256: "b"},
		}})
		h.checkText = incomplete
		callDownloadsHF(t, dl, h, "POST", "/api/downloads", `{"hf":{"repo":"o/r","quant":"BF16"}}`)
		if len(h.checked) != 0 || !slices.Equal(dl.calls, []string{"start pick hf:o/r:BF16"}) {
			t.Fatalf("checked %v, calls %v", h.checked, dl.calls)
		}
	})
}

func TestStartHFQueuesThePickAtTheListedRevision(t *testing.T) {
	dl, h := &stubDownloads{}, listedRepo()
	rec := callDownloadsHF(t, dl, h, "POST", "/api/downloads", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("start = %d %s", rec.Code, rec.Body)
	}
	if h.owner != "o" || h.name != "r" {
		t.Fatalf("listing asked for %s/%s", h.owner, h.name)
	}
	want := store.HFPick{ID: "hf:o/r:Q4_K_M", Repo: "o/r", Revision: strings.Repeat("a", 40), Quant: "Q4_K_M",
		Files: []store.HFPickFile{
			{Name: "m-Q4_K_M.gguf", Path: "m-Q4_K_M.gguf", SizeBytes: 5, SHA256: "s4"},
			{Name: "mmproj-F16.gguf", Path: "proj/mmproj-F16.gguf", SizeBytes: 2, SHA256: "sp"},
		}}
	if !reflect.DeepEqual(dl.pick, want) {
		t.Fatalf("pick = %+v, want %+v", dl.pick, want)
	}
}

func TestStartHFErrors(t *testing.T) {
	cases := []struct {
		name, body   string
		hfErr, dlErr error
		status       int
		code         string
	}{
		{"unknown quant", `{"hf":{"repo":"o/r","quant":"Q2_K"}}`, nil, nil, 404, "hf_quant_not_found"},
		{"unreachable", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`, hf.ErrUnreachable, nil, 502, "hf_unreachable"},
		{"no database", `{"hf":{"repo":"o/r","quant":"Q4_K_M"}}`, nil, downloads.ErrNoPicks, 503, "downloads_unavailable"},
		{"catalog and hf", `{"catalogId":"a","hf":{"repo":"o/r","quant":"Q4_K_M"}}`, nil, nil, 400, "bad_request"},
		{"repo without a slash", `{"hf":{"repo":"r","quant":"Q4_K_M"}}`, nil, nil, 400, "bad_request"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := listedRepo()
			h.err = c.hfErr
			rec := callDownloadsHF(t, &stubDownloads{err: c.dlErr}, h, "POST", "/api/downloads", c.body)
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), `"error":"`+c.code+`"`) {
				t.Fatalf("%d %s, want %d %s", rec.Code, rec.Body, c.status, c.code)
			}
		})
	}
}

func TestDownloadRoutesTakeAnEncodedPickID(t *testing.T) {
	dl := &stubDownloads{}
	cases := []struct{ method, path, call string }{
		{"DELETE", "/api/downloads/hf%3Ao%2Fr%3AQ4_K_M", "cancel hf:o/r:Q4_K_M"},
		{"POST", "/api/downloads/hf%3Ao%2Fr%3AQ4_K_M/resume", "resume hf:o/r:Q4_K_M"},
		{"POST", "/api/downloads/hf%3Ao%2Fr%3AQ4_K_M/pause", "pause hf:o/r:Q4_K_M"},
	}
	for _, c := range cases {
		if rec := callDownloads(t, dl, c.method, c.path, ""); rec.Code != http.StatusAccepted {
			t.Fatalf("%s %s = %d %s", c.method, c.path, rec.Code, rec.Body)
		}
		if got := dl.calls[len(dl.calls)-1]; got != c.call {
			t.Fatalf("queue got %q, want %q", got, c.call)
		}
	}
}

func TestDownloadEndpointsCallTheQueue(t *testing.T) {
	dl := &stubDownloads{}
	cases := []struct{ method, path, body, call string }{
		{"POST", "/api/downloads", `{"catalogId":"qwen"}`, "start qwen"},
		{"POST", "/api/downloads", `{"engine":"cuda"}`, "start engine"},
		{"DELETE", "/api/downloads/qwen", "", "cancel qwen"},
		{"POST", "/api/downloads/qwen/resume", "", "resume qwen"},
		{"POST", "/api/downloads/qwen/pause", "", "pause qwen"},
	}
	for _, c := range cases {
		if rec := callDownloads(t, dl, c.method, c.path, c.body); rec.Code != http.StatusAccepted {
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
		rec := callDownloads(t, &stubDownloads{err: c.err}, "POST", "/api/downloads/qwen/resume", "")
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.code) {
			t.Fatalf("%v -> %d %s, want %d %s", c.err, rec.Code, rec.Body, c.status, c.code)
		}
	}
}

func TestPauseOfWhatIsNotRunningIsNotRunning(t *testing.T) {
	dl := &stubDownloads{err: downloads.ErrNotRunning}
	rec := callDownloads(t, dl, "POST", "/api/downloads/qwen/pause", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"error":"not_running"`) {
		t.Fatalf("pause -> %d %s, want 409 not_running", rec.Code, rec.Body)
	}
	if len(dl.calls) != 1 || dl.calls[0] != "pause qwen" {
		t.Fatalf("calls = %v", dl.calls)
	}
}

func TestStartRejectsBadBodies(t *testing.T) {
	for _, body := range []string{``, `{}`, `{"catalogId":"a","engine":"cuda"}`, `{"catalogId":"a","x":1}`, `{"engine":"rocm"}`, `nope`} {
		dl := &stubDownloads{}
		if rec := callDownloads(t, dl, "POST", "/api/downloads", body); rec.Code != http.StatusBadRequest || len(dl.calls) != 0 {
			t.Fatalf("body %q -> %d, calls %v", body, rec.Code, dl.calls)
		}
	}
}

func TestListDownloads(t *testing.T) {
	if rec := callDownloads(t, &stubDownloads{}, "GET", "/api/downloads", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"items":[]}` {
		t.Fatalf("empty queue: %d %s", rec.Code, rec.Body)
	}
	dl := &stubDownloads{items: []downloads.DownloadItem{{ID: "qwen", Name: "qwen.gguf", State: downloads.Downloading, Bytes: 5, Total: 10}}}
	rec := callDownloads(t, dl, "GET", "/api/downloads", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `{"items":[{"id":"qwen","name":"qwen.gguf","state":"downloading"`) {
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
		rec := callDownloads(t, &stubDownloads{}, "POST", "/api/downloads", c.body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"error":"`+c.code+`"`) {
			t.Errorf("body %s -> %d %s, want 400 %s", c.body, rec.Code, rec.Body, c.code)
		}
	}
}

func TestStartAcceptsBodiesUpTo1MiB(t *testing.T) {
	dl := &stubDownloads{}
	body := `{"catalogId":"qwen"` + strings.Repeat(" ", 4<<10) + `}`
	if rec := callDownloads(t, dl, "POST", "/api/downloads", body); rec.Code != http.StatusAccepted {
		t.Fatalf("a 4 KiB body: %d %s", rec.Code, rec.Body)
	}
}
