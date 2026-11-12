package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

func callModels(rt Router, method, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	list := func() ([]models.Model, error) {
		return []models.Model{{ID: "qwen", SizeBytes: 5, Kind: models.KindChat}, {ID: "gemma", SizeBytes: 7, Kind: models.KindChat}}, nil
	}
	testHandler(Deps{Router: rt, ListModels: list}).ServeHTTP(rec, req)
	return rec
}

func TestListModelsShowsDiskModelsWithRouterState(t *testing.T) {
	rt := &stubRouter{snapshot: []router.ModelState{{ID: "qwen", State: router.StateReady, Busy: true}}}
	rec := callModels(rt, http.MethodGet, "/api/models")
	want := `{"models":[` +
		`{"id":"qwen","state":"ready","busy":true,"sizeBytes":5,"kind":"chat"},` +
		`{"id":"gemma","state":"stopped","busy":false,"sizeBytes":7,"kind":"chat"}]}`
	if got := strings.TrimSpace(rec.Body.String()); rec.Code != http.StatusOK || got != want {
		t.Fatalf("status = %d, body = %s\nwant %s", rec.Code, got, want)
	}
}

func TestStateRouteIsGone(t *testing.T) {
	if rec := callModels(&stubRouter{}, http.MethodGet, "/api/state"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestLoadAndUnload(t *testing.T) {
	cases := []struct {
		name     string
		rt       *stubRouter
		path     string
		status   int
		contains string
	}{
		{"load", &stubRouter{}, "/api/models/qwen/load", 200, `{"status":"ready"}`},
		{"load of an unknown model", &stubRouter{err: router.ErrUnknownModel}, "/api/models/nope/load", 404, `"error":"model_not_found"`},
		{"failed load", &stubRouter{err: errors.New("llama-server exited")}, "/api/models/qwen/load", 503, `"error":"model_load_failed","message":"llama-server exited"`},
		{"unload", &stubRouter{unloadOK: true}, "/api/models/qwen/unload", 202, `{"status":"stopped"}`},
		{"unload of a model not loaded", &stubRouter{}, "/api/models/qwen/unload", 404, `"error":"model_not_loaded"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := callModels(c.rt, http.MethodPost, c.path)
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.contains) {
				t.Fatalf("status = %d, body = %s; want %d with %s", rec.Code, rec.Body.String(), c.status, c.contains)
			}
		})
	}
	rt := &stubRouter{unloadOK: true}
	callModels(rt, http.MethodPost, "/api/models/qwen/load")
	callModels(rt, http.MethodPost, "/api/models/gemma/unload")
	if rt.loaded != "qwen" || rt.unloaded != "gemma" {
		t.Fatalf("loaded %q, unloaded %q", rt.loaded, rt.unloaded)
	}
}

func TestRefreshNotifiesOnce(t *testing.T) {
	rt := &stubRouter{}
	rec := callModels(rt, http.MethodPost, "/api/models/refresh")
	if rec.Code != http.StatusAccepted || rt.notified != 1 {
		t.Fatalf("status %d, notified %d times; want 202 and once", rec.Code, rt.notified)
	}
}
