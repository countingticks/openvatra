package api

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

func twoModels() ([]models.Model, error) {
	return []models.Model{
		{ID: "a", SizeBytes: 10, Kind: models.KindEmbedding},
		{ID: "b", SizeBytes: 20, MMProj: `D:\m\mmproj-b.gguf`, Kind: models.KindChat},
		{ID: "c", SizeBytes: 5, Kind: models.KindUnreadable, Error: "not a GGUF file"},
	}, nil
}

func TestStateMergesRouterWithDiscoveredModels(t *testing.T) {
	rt := &stubRouter{snapshot: []router.ModelState{{ID: "b", State: router.StateReady, Busy: true}}}
	rec := httptest.NewRecorder()
	stateHandler(rt, twoModels)(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))

	want := `{"models":[{"id":"a","state":"stopped","busy":false,"sizeBytes":10,"kind":"embedding"},{"id":"b","state":"ready","busy":true,"sizeBytes":20,"projector":"mmproj-b.gguf","kind":"chat"},{"id":"c","state":"stopped","busy":false,"sizeBytes":5,"kind":"unreadable","error":"not a GGUF file"}]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s\nwant   %s", got, want)
	}
}

func TestEventsSendsStateNowAndAfterEachChange(t *testing.T) {
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	srv := httptest.NewServer(eventsHandler(rt, twoModels, nil, nil))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}

	sc := bufio.NewScanner(resp.Body)
	readEvent := func() string {
		var lines []string
		for sc.Scan() {
			if sc.Text() == "" {
				return strings.Join(lines, "|")
			}
			lines = append(lines, sc.Text())
		}
		return "stream ended"
	}

	if got := readEvent(); !strings.HasPrefix(got, "event: state|data: {") || !strings.Contains(got, `"state":"stopped"`) {
		t.Fatalf("first event = %q", got)
	}
	rt.snapshot = []router.ModelState{{ID: "a", State: router.StateLoading}}
	rt.changes <- struct{}{}
	done := make(chan string, 1)
	go func() { done <- readEvent() }()
	select {
	case got := <-done:
		if !strings.Contains(got, `"state":"loading"`) {
			t.Fatalf("second event = %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no event after a change")
	}
}

func TestRefreshEndpointNotifiesListeners(t *testing.T) {
	rt := &stubRouter{}
	rec := httptest.NewRecorder()
	refreshHandler(rt).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/models/refresh", nil))
	if rec.Code != http.StatusAccepted || rt.notified != 1 {
		t.Fatalf("status %d, notified %d times; want 202 and once", rec.Code, rt.notified)
	}
}

func TestLoadAndUnloadEndpoints(t *testing.T) {
	rt := &stubRouter{unloadOK: true}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/models/{id}/load", loadHandler(rt))
	mux.HandleFunc("POST /api/models/{id}/unload", unloadHandler(rt))

	do := func(path string) int {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		return rec.Code
	}

	if code := do("/api/models/qwen/load"); code != http.StatusOK || rt.loaded != "qwen" {
		t.Fatalf("load: status %d, loaded %q", code, rt.loaded)
	}
	if code := do("/api/models/qwen/unload"); code != http.StatusAccepted || rt.unloaded != "qwen" {
		t.Fatalf("unload: status %d, unloaded %q", code, rt.unloaded)
	}
	rt.unloadOK = false
	if code := do("/api/models/qwen/unload"); code != http.StatusNotFound {
		t.Fatalf("unload of a stopped model: status %d, want 404", code)
	}
	rt.err = router.ErrUnknownModel
	if code := do("/api/models/nope/load"); code != http.StatusNotFound {
		t.Fatalf("load of an unknown model: status %d, want 404", code)
	}
	rt.err = errors.New("boom")
	if code := do("/api/models/qwen/load"); code != http.StatusServiceUnavailable {
		t.Fatalf("failed load: status %d, want 503", code)
	}
}

// configStream starts the real handler over HTTP with a config store, opens /api/events and returns the SSE
// messages as they arrive ("event|data" strings), plus a helper that sends a request with the token.
func configStream(t *testing.T, rt *stubRouter, cfg Config, before func(call func(method, path, body string) int)) (events <-chan string, call func(method, path, body string) int) {
	t.Helper()
	srv := httptest.NewUnstartedServer(nil)
	_, portText, _ := strings.Cut(srv.Listener.Addr().String(), ":")
	port, _ := strconv.Atoi(portText)
	srv.Config.Handler = NewHandler(testToken, port, func() {}, twoModels, rt, cfg, config.NewOverride(), stubHardware{}, stubCatalog{}, nil, nil)
	srv.Start()
	t.Cleanup(srv.Close)

	call = func(method, path, body string) int {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if before != nil {
		before(call)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	out := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		var lines []string
		for sc.Scan() {
			if sc.Text() == "" {
				out <- strings.Join(lines, "|")
				lines = nil
				continue
			}
			lines = append(lines, sc.Text())
		}
	}()
	return out, call
}

func nextEvent(t *testing.T, events <-chan string) string {
	t.Helper()
	select {
	case e := <-events:
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("no event")
		return ""
	}
}

func expectNoEvent(t *testing.T, events <-chan string) {
	t.Helper()
	select {
	case e := <-events:
		t.Fatalf("unexpected event %q", e)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestEventsAnnounceConfigWrites(t *testing.T) {
	cfg := configStore(t, true)
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	events, call := configStream(t, rt, cfg, nil)
	if e := nextEvent(t, events); !strings.HasPrefix(e, "event: state|") {
		t.Fatalf("first event = %q", e)
	}
	expectNoEvent(t, events) // nothing about config when the stream opens

	if code := call(http.MethodPut, "/api/config/models", `{"rev":0,"value":`+modelsValue+`}`); code != 200 {
		t.Fatalf("put = %d", code)
	}
	if e := nextEvent(t, events); e != `event: config|data: {"section":"models","rev":1}` {
		t.Fatalf("event = %q", e)
	}
}

func TestEventsOpenedAfterAWriteSendNoConfigEvent(t *testing.T) {
	cfg := configStore(t, true)
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	events, call := configStream(t, rt, cfg, func(call func(method, path, body string) int) {
		if code := call(http.MethodPut, "/api/config/models", `{"rev":0,"value":`+modelsValue+`}`); code != 200 {
			t.Fatalf("put = %d", code)
		}
	})
	if e := nextEvent(t, events); !strings.HasPrefix(e, "event: state|") {
		t.Fatalf("first event = %q", e)
	}
	expectNoEvent(t, events)

	call(http.MethodPut, "/api/config/models", `{"rev":1,"value":`+modelsValue+`}`)
	if e := nextEvent(t, events); e != `event: config|data: {"section":"models","rev":2}` {
		t.Fatalf("event = %q", e)
	}
}

func TestPostConfigSendsNoConfigEvent(t *testing.T) {
	cfg := configStore(t, true)
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	events, call := configStream(t, rt, cfg, nil)
	nextEvent(t, events) // state
	if code := call(http.MethodPost, "/api/config", `{"modelsDir":"D:/models","idleUnloadMinutes":null,"options":{}}`); code != http.StatusNoContent {
		t.Fatalf("post = %d", code)
	}
	rt.changes <- struct{}{} // a following state event proves the stream is alive and in order
	if e := nextEvent(t, events); !strings.HasPrefix(e, "event: state|") {
		t.Fatalf("event after POST = %q", e)
	}
	expectNoEvent(t, events)
}
