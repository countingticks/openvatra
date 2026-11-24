package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/fit"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/removal"
)

func callModels(t *testing.T, rt provider.Resident, method, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	list := func() ([]models.Model, error) {
		return []models.Model{{ID: "qwen", SizeBytes: 5, Kind: models.KindChat}, {ID: "gemma", SizeBytes: 7, Kind: models.KindChat}}, nil
	}
	testHandler(t, Deps{Resident: rt, ListModels: list}).ServeHTTP(rec, req)
	return rec
}

func TestListModelsShowsDiskModelsWithRouterState(t *testing.T) {
	rt := &stubRouter{snapshot: []provider.ModelState{{ID: "qwen", State: provider.StateReady, Busy: true}}}
	rec := callModels(t, rt, http.MethodGet, "/api/models")
	want := `{"models":[` +
		`{"id":"qwen","state":"ready","busy":true,"sizeBytes":5,"kind":"chat","context":null,"moe":false,"name":"","quant":null,"tags":[],"memory":null},` +
		`{"id":"gemma","state":"stopped","busy":false,"sizeBytes":7,"kind":"chat","context":null,"moe":false,"name":"","quant":null,"tags":[],"memory":null}]}`
	if got := strings.TrimSpace(rec.Body.String()); rec.Code != http.StatusOK || got != want {
		t.Fatalf("status = %d, body = %s\nwant %s", rec.Code, got, want)
	}
}

func TestListModelsStatesAndKindsAreDocumentedEnumValues(t *testing.T) {
	rt := &stubRouter{snapshot: []provider.ModelState{
		{ID: "a", State: provider.StateLoading},
		{ID: "b", State: provider.StateReady},
		{ID: "c", State: provider.StateError, Error: "exited"},
	}}
	list := func() ([]models.Model, error) {
		return []models.Model{
			{ID: "a", Kind: models.KindChat},
			{ID: "b", Kind: models.KindEmbedding},
			{ID: "c", Kind: models.KindChat},
			{ID: "d", Kind: models.KindUnreadable, Error: "not a GGUF file"},
		}, nil
	}
	req := httptest.NewRequest(http.MethodGet, "/api/models", nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	// checked fails the test on a state or kind outside the document's enum.
	testHandler(t, Deps{Resident: rt, ListModels: list}).ServeHTTP(rec, req)
	for _, want := range []string{`"state":"loading"`, `"state":"ready"`, `"state":"error"`, `"state":"stopped"`,
		`"kind":"chat"`, `"kind":"embedding"`, `"kind":"unreadable"`} {
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("status = %d, body = %s; want %s", rec.Code, rec.Body.String(), want)
		}
	}
}

func TestStateRouteIsGone(t *testing.T) {
	if rec := callModels(t, &stubRouter{}, http.MethodGet, "/api/state"); rec.Code != http.StatusNotFound {
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
		{"load of an unknown model", &stubRouter{err: provider.ErrUnknownModel}, "/api/models/nope/load", 404, `"error":"model_not_found"`},
		{"failed load", &stubRouter{err: errors.New("llama-server exited")}, "/api/models/qwen/load", 503, `"error":"model_load_failed","message":"llama-server exited"`},
		{
			"refused load", &stubRouter{err: &provider.RefusedError{Model: "x", Reason: "This file is not a chat model"}},
			"/api/models/x/load", 503, `"error":"model_load_failed","message":"This file is not a chat model"`,
		},
		{"unload", &stubRouter{unloadOK: true}, "/api/models/qwen/unload", 202, `{"status":"stopped"}`},
		{"unload of a model not loaded", &stubRouter{}, "/api/models/qwen/unload", 404, `"error":"model_not_loaded"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := callModels(t, c.rt, http.MethodPost, c.path)
			if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.contains) {
				t.Fatalf("status = %d, body = %s; want %d with %s", rec.Code, rec.Body.String(), c.status, c.contains)
			}
		})
	}
	rt := &stubRouter{unloadOK: true}
	callModels(t, rt, http.MethodPost, "/api/models/qwen/load")
	callModels(t, rt, http.MethodPost, "/api/models/gemma/unload")
	if rt.loaded != "qwen" || rt.unloaded != "gemma" {
		t.Fatalf("loaded %q, unloaded %q", rt.loaded, rt.unloaded)
	}
}

func TestRefreshNotifiesOnce(t *testing.T) {
	rt := &stubRouter{}
	rec := callModels(t, rt, http.MethodPost, "/api/models/refresh")
	if rec.Code != http.StatusAccepted || rt.notified != 1 {
		t.Fatalf("status %d, notified %d times; want 202 and once", rec.Code, rt.notified)
	}
}

func TestListModelsCarriesContextChoiceAndMoE(t *testing.T) {
	list := func() ([]models.Model, error) {
		return []models.Model{
			{ID: "a", Kind: models.KindChat, Shape: engine.Shape{ExpertBytes: 1}},
			{ID: "b", Kind: models.KindEmbedding},
		}, nil
	}
	choose := func(m models.Model) *fit.Choice {
		if m.Kind != models.KindChat {
			return nil
		}
		return &fit.Choice{Context: 8192, Placement: fit.PlaceExperts, Fit: "slower", Source: "estimate"}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/models", nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	// checked fails the test on a fit, placement or source outside the document's enum.
	testHandler(t, Deps{Resident: &stubRouter{}, ListModels: list, Choose: choose}).ServeHTTP(rec, req)
	body := rec.Body.String()
	for _, want := range []string{`"context":{"context":8192,"placement":"experts"`, `"moe":true`, `"context":null,"moe":false`} {
		if rec.Code != http.StatusOK || !strings.Contains(body, want) {
			t.Fatalf("status = %d, body = %s; want %s", rec.Code, body, want)
		}
	}
}

// fitRecorder is a Deps.Fit that keeps what it was asked.
type fitRecorder struct {
	calls     int
	id        string
	context   int
	placement string
	err       error
}

func (f *fitRecorder) fit(id string, context int, placement string) (fit.Choice, error) {
	f.calls++
	f.id, f.context, f.placement = id, context, placement
	if f.err != nil {
		return fit.Choice{}, f.err
	}
	return fit.Choice{Context: context, Placement: fit.PlaceExperts, Fit: "fits", Source: "estimate"}, nil
}

func callFit(t *testing.T, f *fitRecorder, query, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/models/qwen/fit"+query, nil)
	req.Host = "127.0.0.1:53121"
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	testHandler(t, Deps{Fit: f.fit}).ServeHTTP(rec, req)
	return rec
}

func TestFitRoute(t *testing.T) {
	t.Run("the query reaches Fit and the choice comes back as JSON", func(t *testing.T) {
		f := &fitRecorder{}
		rec := callFit(t, f, "?context=32768&placement=experts", testToken)
		want := `"context":32768,"placement":"experts"`
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), want) ||
			f.id != "qwen" || f.context != 32768 || f.placement != "experts" {
			t.Fatalf("status = %d, body = %s, asked %+v", rec.Code, rec.Body.String(), f)
		}
	})
	t.Run("no query means auto", func(t *testing.T) {
		f := &fitRecorder{}
		if rec := callFit(t, f, "", testToken); rec.Code != http.StatusOK || f.context != 0 || f.placement != "auto" {
			t.Fatalf("status = %d, asked %+v", rec.Code, f)
		}
	})
	t.Run("context=auto means auto", func(t *testing.T) {
		f := &fitRecorder{}
		if rec := callFit(t, f, "?context=auto", testToken); rec.Code != http.StatusOK || f.context != 0 {
			t.Fatalf("status = %d, asked %+v", rec.Code, f)
		}
	})
	for _, q := range []string{"?context=abc", "?context=1024", "?context=2000000", "?placement=middle"} {
		t.Run("refuses "+q, func(t *testing.T) {
			f := &fitRecorder{}
			rec := callFit(t, f, q, testToken)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"error":"invalid_request"`) || f.calls != 0 {
				t.Fatalf("status = %d, body = %s, calls = %d", rec.Code, rec.Body.String(), f.calls)
			}
		})
	}
	t.Run("an unknown model is 404", func(t *testing.T) {
		rec := callFit(t, &fitRecorder{err: provider.ErrUnknownModel}, "", testToken)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"error":"model_not_found"`) {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("an unreadable folder is 500", func(t *testing.T) {
		rec := callFit(t, &fitRecorder{err: errors.New("boom")}, "", testToken)
		if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"error":"models_unreadable"`) {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("without a token is 401", func(t *testing.T) {
		if rec := callFit(t, &fitRecorder{}, "", ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", rec.Code)
		}
	})
}

func TestRemoveModel(t *testing.T) {
	rm := &stubRemoval{}
	rec := postPath(t, testHandler(t, Deps{Removal: rm}), testToken, "/api/models/qwen-q4/remove")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if len(rm.ids) != 1 || rm.ids[0] != "qwen-q4" {
		t.Errorf("removed %v, want [qwen-q4]", rm.ids)
	}
}

func TestRemoveModelErrors(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{removal.ErrModelBusy, http.StatusConflict, "model_busy"},
		{provider.ErrUnknownModel, http.StatusNotFound, "model_not_found"},
		{removal.ErrOutside, http.StatusConflict, "outside_models_folder"},
		{fmt.Errorf("%w: %v", removal.ErrTrashFailed, errors.New("0x7c")), http.StatusInternalServerError, "trash_failed"},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			rec := postPath(t, testHandler(t, Deps{Removal: &stubRemoval{err: tt.err}}), testToken, "/api/models/qwen/remove")
			var body ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body %s: %v", rec.Body, err)
			}
			if rec.Code != tt.status || body.Error != tt.code {
				t.Errorf("got %d %+v, want %d %s", rec.Code, body, tt.status, tt.code)
			}
		})
	}
}
