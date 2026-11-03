package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/models"
)

const (
	testToken = "s3cret"
	testPort  = 53121
)

// do sends a request through the full handler; host and auth override the defaults when non-empty.
func do(t *testing.T, path, host, auth string) *httptest.ResponseRecorder {
	t.Helper()
	return doMethod(t, http.MethodGet, path, host, auth, func() {})
}

func doMethod(t *testing.T, method, path, host, auth string, shutdown func()) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Host = "127.0.0.1:53121"
	if host != "" {
		req.Host = host
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	list := func() ([]models.Model, error) { return []models.Model{{ID: "qwen"}, {ID: "gemma"}}, nil }
	if method == http.MethodGet && path == "/v1/models?fail" {
		list = func() ([]models.Model, error) { return nil, errors.New("boom") }
	}
	NewHandler(testToken, testPort, shutdown, list, nil, config.NewStore()).ServeHTTP(rec, req)
	return rec
}

func TestModelsList(t *testing.T) {
	rec := do(t, "/v1/models", "", "Bearer "+testToken)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	want := `{"data":[{"id":"qwen","object":"model","owned_by":"openvatra"},` +
		`{"id":"gemma","object":"model","owned_by":"openvatra"}],"object":"list"}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s", got)
	}
}

func TestModelsListEmptyIsArrayAndErrorIs500(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	NewHandler(testToken, testPort, func() {}, func() ([]models.Model, error) { return nil, nil }, nil, config.NewStore()).ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"data":[]`) {
		t.Fatalf("body = %s", rec.Body.String())
	}

	rec = do(t, "/v1/models?fail", "", "Bearer "+testToken)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"error":"models_unreadable"`) {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestHealth(t *testing.T) {
	rec := do(t, "/health", "", "Bearer "+testToken)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
		t.Fatalf("body = %s", got)
	}
}

func TestUnknownRouteIs404(t *testing.T) {
	rec := do(t, "/nope", "", "Bearer "+testToken)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestRejectsMissingOrWrongToken(t *testing.T) {
	for name, auth := range map[string]string{
		"missing":      "",
		"wrong":        "Bearer nope",
		"wrong scheme": "Basic " + testToken,
		"bare token":   testToken,
	} {
		t.Run(name, func(t *testing.T) {
			rec := do(t, "/health", "", auth)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			if got := rec.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("content-type = %q", got)
			}
			if !strings.Contains(rec.Body.String(), `"error":"unauthorized"`) {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}

func TestRejectsWrongHost(t *testing.T) {
	for _, host := range []string{"evil.example.com", "localhost:53121", "127.0.0.1:1", "127.0.0.1"} {
		t.Run(host, func(t *testing.T) {
			rec := do(t, "/health", host, "Bearer "+testToken)

			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), `"error":"forbidden_host"`) {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}

func TestShutdownRepliesThenSignals(t *testing.T) {
	called := 0
	rec := doMethod(t, http.MethodPost, "/shutdown", "", "Bearer "+testToken, func() { called++ })

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if called != 1 {
		t.Fatalf("shutdown called %d times, want 1", called)
	}
}

func TestShutdownNeedsTokenAndPost(t *testing.T) {
	called := false
	stop := func() { called = true }

	if rec := doMethod(t, http.MethodPost, "/shutdown", "", "", stop); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status = %d, want 401", rec.Code)
	}
	if rec := doMethod(t, http.MethodGet, "/shutdown", "", "Bearer "+testToken, stop); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: status = %d, want 405", rec.Code)
	}
	if called {
		t.Fatal("shutdown must not run for rejected requests")
	}
}

func TestConfigReplacesTheWholeConfig(t *testing.T) {
	store := config.NewStore()
	post := func(body string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/config", strings.NewReader(body))
		req.Host = "127.0.0.1:53121"
		req.Header.Set("Authorization", "Bearer "+testToken)
		rec := httptest.NewRecorder()
		NewHandler(testToken, testPort, func() {}, nil, nil, store).ServeHTTP(rec, req)
		if rec.Code != 204 {
			t.Log(rec.Body.String())
		}
		return rec.Code
	}

	if code := post(`{"modelsDir":"D:/models","idleUnloadMinutes":null,"sharedArgs":["-fa","on"],"options":{"a":{"args":["-c","4096"]}}}`); code != http.StatusNoContent {
		t.Fatalf("valid config: status = %d, want 204", code)
	}
	got := store.Get()
	if got.ModelsDir != `D:/models` || got.IdleUnloadMinutes != 0 || len(got.SharedArgs) != 2 || len(got.Options["a"].Args) != 2 {
		t.Fatalf("stored = %+v", got)
	}

	for name, body := range map[string]string{
		"not json":      `{`,
		"unknown field": `{"modelDir":"x"}`,
		"invalid value": `{"idleUnloadMinutes":-5}`,
	} {
		if code := post(body); code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, code)
		}
	}
	if store.Get().ModelsDir != `D:/models` {
		t.Fatal("a rejected request changed the config")
	}
}
