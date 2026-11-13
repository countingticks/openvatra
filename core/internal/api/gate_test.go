package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/models"
)

const testOrigin = "http://localhost:5173"

// gateFixture is the handler NewHandler builds, without checked's loopback rewrite, plus its token store so a
// test can issue ui tokens.
type gateFixture struct {
	h         http.Handler
	tokens    *tokens
	shutdowns int
}

func newGate(t *testing.T) *gateFixture {
	t.Helper()
	f := &gateFixture{}
	d := testDeps(Deps{
		Origins:    []string{testOrigin},
		Router:     &stubRouter{},
		ListModels: func() ([]models.Model, error) { return nil, nil },
		Shutdown:   func() { f.shutdowns++ },
	})
	f.tokens = newTokens(d.Token)
	f.h = gate(f.tokens, d.Port, d.Origins, newMux(Routes(d), nil))
	return f
}

// gateReq is one request; empty fields take the defaults of a request main would send.
type gateReq struct {
	method, path, remote, host, auth, origin, body string
	noAuth                                         bool
}

func (f *gateFixture) send(q gateReq) *httptest.ResponseRecorder {
	if q.method == "" {
		q.method = http.MethodGet
	}
	req := httptest.NewRequest(q.method, q.path, strings.NewReader(q.body))
	req.RemoteAddr = "127.0.0.1:50000"
	if q.remote != "" {
		req.RemoteAddr = q.remote
	}
	req.Host = "127.0.0.1:53121"
	if q.host != "" {
		req.Host = q.host
	}
	if q.auth == "" && !q.noAuth {
		q.auth = "Bearer " + testToken
	}
	if q.auth != "" {
		req.Header.Set("Authorization", q.auth)
	}
	if q.origin != "" {
		req.Header.Set("Origin", q.origin)
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	return rec
}

func wantCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status || !strings.Contains(rec.Body.String(), `"error":"`+code+`"`) {
		t.Fatalf("got %d %s, want %d %s", rec.Code, rec.Body.String(), status, code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
}

func TestGateRefusesARemoteAddressEvenWithTheToken(t *testing.T) {
	rec := newGate(t).send(gateReq{path: "/api/version", remote: "192.0.2.1:1234"})
	wantCode(t, rec, http.StatusForbidden, "forbidden_remote")
}

func TestRejectsWrongHost(t *testing.T) {
	for _, host := range []string{"evil.example.com", "localhost:53121", "127.0.0.1:1", "127.0.0.1"} {
		t.Run(host, func(t *testing.T) {
			wantCode(t, newGate(t).send(gateReq{path: "/health", host: host}), http.StatusForbidden, "forbidden_host")
		})
	}
}

func TestRejectsMissingOrWrongToken(t *testing.T) {
	for name, auth := range map[string]string{
		"missing":      "",
		"wrong":        "Bearer nope",
		"wrong scheme": "Basic " + testToken,
		"bare token":   testToken,
		"empty bearer": "Bearer ",
	} {
		t.Run(name, func(t *testing.T) {
			rec := newGate(t).send(gateReq{path: "/api/version", auth: auth, noAuth: auth == ""})
			wantCode(t, rec, http.StatusUnauthorized, "unauthorized")
			if strings.Contains(rec.Body.String(), testToken) {
				t.Fatalf("the token is in the answer: %s", rec.Body.String())
			}
		})
	}
}

func TestHealthAnswersWithoutAToken(t *testing.T) {
	if rec := newGate(t).send(gateReq{path: "/health", noAuth: true}); rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
	}
}

func TestGateRefusesAnUnlistedOrigin(t *testing.T) {
	for _, origin := range []string{"https://evil.example.com", "http://localhost:5174", "null"} {
		t.Run(origin, func(t *testing.T) {
			rec := newGate(t).send(gateReq{path: "/api/version", origin: origin})
			wantCode(t, rec, http.StatusForbidden, "forbidden_origin")
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
				t.Fatalf("Access-Control-Allow-Origin = %q on a refused origin", got)
			}
		})
	}
}

func TestAllowedOriginGetsCORSHeadersOnEveryAnswer(t *testing.T) {
	f := newGate(t)
	for _, c := range []struct {
		auth   string
		status int
	}{{"", http.StatusOK}, {"Bearer nope", http.StatusUnauthorized}} {
		t.Run(http.StatusText(c.status), func(t *testing.T) {
			rec := f.send(gateReq{path: "/api/version", origin: testOrigin, auth: c.auth})
			if rec.Code != c.status {
				t.Fatalf("status = %d, want %d", rec.Code, c.status)
			}
			h := rec.Header()
			if h.Get("Access-Control-Allow-Origin") != testOrigin || h.Get("Vary") != "Origin" ||
				h.Get("Access-Control-Expose-Headers") != "Content-Type" {
				t.Fatalf("CORS headers = %v", h)
			}
		})
	}
	rec := f.send(gateReq{path: "/api/version"})
	for _, k := range []string{"Access-Control-Allow-Origin", "Vary", "Access-Control-Expose-Headers"} {
		if v := rec.Header().Get(k); v != "" {
			t.Fatalf("%s = %q without an Origin", k, v)
		}
	}
}

func TestPreflightFromAnAllowedOriginNeedsNoToken(t *testing.T) {
	f := newGate(t)
	rec := f.send(gateReq{method: http.MethodOptions, path: "/api/config/models", origin: testOrigin, noAuth: true})
	h := rec.Header()
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 ||
		h.Get("Access-Control-Allow-Origin") != testOrigin ||
		h.Get("Access-Control-Allow-Methods") != "GET, POST, PUT, PATCH, DELETE" ||
		h.Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" ||
		h.Get("Access-Control-Max-Age") != "600" {
		t.Fatalf("got %d %q, headers %v", rec.Code, rec.Body.String(), h)
	}
	other := f.send(gateReq{method: http.MethodOptions, path: "/api/config/models", origin: "https://evil.example.com", noAuth: true})
	wantCode(t, other, http.StatusForbidden, "forbidden_origin")
}

func TestUITokenCannotCallShellRows(t *testing.T) {
	f := newGate(t)
	ui, err := f.tokens.issue(UI)
	if err != nil {
		t.Fatal(err)
	}
	rec := f.send(gateReq{method: http.MethodPost, path: "/shutdown", auth: "Bearer " + ui})
	wantCode(t, rec, http.StatusForbidden, "forbidden_scope")
	if f.shutdowns != 0 {
		t.Fatalf("shutdown ran %d times for a ui token", f.shutdowns)
	}
	if rec := f.send(gateReq{path: "/api/models", auth: "Bearer " + ui}); rec.Code != http.StatusOK {
		t.Fatalf("GET /api/models with a ui token: %d %s", rec.Code, rec.Body.String())
	}
}

func TestNinthUITokenDropsTheOldest(t *testing.T) {
	f := newGate(t)
	var issued []string
	for range 9 {
		tok, err := f.tokens.issue(UI)
		if err != nil {
			t.Fatal(err)
		}
		if len(tok) != 64 || strings.Trim(tok, "0123456789abcdef") != "" {
			t.Fatalf("token %q is not 64 lowercase hex", tok)
		}
		issued = append(issued, tok)
	}
	wantCode(t, f.send(gateReq{path: "/api/version", auth: "Bearer " + issued[0]}), http.StatusUnauthorized, "unauthorized")
	for _, tok := range []string{issued[1], issued[8], testToken} {
		if rec := f.send(gateReq{path: "/api/version", auth: "Bearer " + tok}); rec.Code != http.StatusOK {
			t.Fatalf("a live token got %d", rec.Code)
		}
	}
}

func TestIssuingAShellTokenFails(t *testing.T) {
	if tok, err := newTokens(testToken).issue(Shell); err == nil || tok != "" {
		t.Fatalf("issue(Shell) = %q, %v; want an error", tok, err)
	}
}
