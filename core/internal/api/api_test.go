package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testToken = "s3cret"
	testPort  = 53121
)

// do sends a request through the full handler; host and auth override the defaults when non-empty.
func do(t *testing.T, path, host, auth string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:53121"
	if host != "" {
		req.Host = host
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	NewHandler(testToken, testPort).ServeHTTP(rec, req)
	return rec
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
