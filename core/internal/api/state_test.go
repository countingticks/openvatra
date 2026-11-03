package api

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

func twoModels() ([]models.Model, error) {
	return []models.Model{
		{ID: "a", SizeBytes: 10},
		{ID: "b", SizeBytes: 20, MMProj: `D:\m\mmproj-b.gguf`},
	}, nil
}

func TestStateMergesRouterWithDiscoveredModels(t *testing.T) {
	rt := &stubRouter{snapshot: []router.ModelState{{ID: "b", State: router.StateReady, Busy: true}}}
	rec := httptest.NewRecorder()
	stateHandler(rt, twoModels)(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))

	want := `{"models":[{"id":"a","state":"stopped","busy":false,"sizeBytes":10},{"id":"b","state":"ready","busy":true,"sizeBytes":20,"projector":"mmproj-b.gguf"}]}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s\nwant   %s", got, want)
	}
}

func TestEventsSendsStateNowAndAfterEachChange(t *testing.T) {
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	srv := httptest.NewServer(eventsHandler(rt, twoModels))
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
