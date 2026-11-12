package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/countingticks/openvatra/core/internal/router"
)

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
