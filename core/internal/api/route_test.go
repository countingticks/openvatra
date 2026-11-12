package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/router"
	"github.com/countingticks/openvatra/core/internal/store"
)

type lookupIn struct {
	ID    string   `path:"id"`
	After int64    `query:"after"`
	Types []string `query:"types"`
	Fresh *bool    `query:"fresh"`
}

type inner struct {
	Kind string `json:"kind" enum:"a,b"`
}

type createIn struct {
	Name  string  `json:"name"`
	Note  *string `json:"note"`
	Size  int     `json:"size,omitempty"`
	Mode  string  `json:"mode,omitempty" enum:"fast,slow"`
	Inner *inner  `json:"inner,omitempty"`
}

type strictEnumIn struct {
	Mode string `json:"mode" enum:"fast,slow"`
}

type validated struct {
	N int `json:"n"`
}

func (v validated) Validate() error {
	switch v.N {
	case 1:
		return &Error{Status: http.StatusConflict, Code: "too_one", Message: "one is too one"}
	case 2:
		return errors.New("two is not allowed")
	}
	return nil
}

type statusOut struct {
	Status string `json:"status"`
}

// echo answers with what the wrapper decoded.
func echo[In any](ctx context.Context, in In) (In, error) { return in, nil }

func testRoutes(fail error) []Route {
	return []Route{
		JSON(http.MethodGet, "/things/{id}", UI, "lookup", "", echo[lookupIn]),
		JSON(http.MethodPost, "/things", UI, "create", "", echo[createIn]),
		JSON(http.MethodPost, "/strict", UI, "strict", "", echo[strictEnumIn]),
		JSON(http.MethodPost, "/validated", UI, "validated", "", echo[validated]),
		JSON(http.MethodPost, "/nobody", UI, "nobody", "", func(context.Context, struct{}) (statusOut, error) {
			return statusOut{"ok"}, nil
		}),
		JSON(http.MethodPost, "/accepted", UI, "accepted", "", func(context.Context, struct{}) (statusOut, error) {
			return statusOut{"accepted"}, nil
		}).WithStatus(http.StatusAccepted),
		JSON(http.MethodDelete, "/gone", UI, "gone", "", func(context.Context, struct{}) (NoContent, error) {
			return NoContent{}, nil
		}),
		JSON(http.MethodGet, "/fail", UI, "fail", "", func(context.Context, struct{}) (struct{}, error) {
			return struct{}{}, fail
		}),
	}
}

type routeResult struct {
	code int
	body string
	log  string
}

func callRoute(t *testing.T, fail error, method, target, body string) routeResult {
	t.Helper()
	return callRouteCtx(t, context.Background(), fail, method, target, body)
}

func callRouteCtx(t *testing.T, ctx context.Context, fail error, method, target, body string) routeResult {
	t.Helper()
	var logBuf bytes.Buffer
	mux := newMux(testRoutes(fail), slog.New(slog.NewTextHandler(&logBuf, nil)))
	req := httptest.NewRequestWithContext(ctx, method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return routeResult{rec.Code, rec.Body.String(), logBuf.String()}
}

func errorOf(t *testing.T, body string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("body %q is not JSON: %v", body, err)
	}
	return m
}

// wantError checks an error answer's status and code, and that its message contains part.
func wantError(t *testing.T, got routeResult, status int, code, part string) {
	t.Helper()
	m := errorOf(t, got.body)
	msg, _ := m["message"].(string)
	if got.code != status || m["error"] != code || !strings.Contains(msg, part) {
		t.Fatalf("got %d %s, want %d %s with %q", got.code, got.body, status, code, part)
	}
}

func TestPathAndQueryReachTheHandler(t *testing.T) {
	got := callRoute(t, nil, http.MethodGet, "/things/qwen?after=42", "")
	if want := `{"ID":"qwen","After":42,"Types":null,"Fresh":null}` + "\n"; got.code != 200 || got.body != want {
		t.Fatalf("got %d %s, want %s", got.code, got.body, want)
	}
	wantError(t, callRoute(t, nil, http.MethodGet, "/things/qwen?after=soon", ""), 400, "invalid_request",
		`query parameter "after" must be an integer`)
}

func TestQueryListAndOptionalBool(t *testing.T) {
	got := callRoute(t, nil, http.MethodGet, "/things/x?types=a,,b&fresh=true", "")
	if !strings.Contains(got.body, `"Types":["a","b"]`) || !strings.Contains(got.body, `"Fresh":true`) {
		t.Fatalf("body = %s", got.body)
	}
	if got := callRoute(t, nil, http.MethodGet, "/things/x", ""); !strings.Contains(got.body, `"Fresh":null`) {
		t.Fatalf("absent bool: body = %s", got.body)
	}
	wantError(t, callRoute(t, nil, http.MethodGet, "/things/x?fresh=maybe", ""), 400, "invalid_request",
		`"fresh" must be a boolean`)
}

func TestBodyDecoding(t *testing.T) {
	got := callRoute(t, nil, http.MethodPost, "/things", `{"name":"a","note":"n","size":3}`)
	if want := `{"name":"a","note":"n","size":3}` + "\n"; got.code != 200 || got.body != want {
		t.Fatalf("got %d %s, want %s", got.code, got.body, want)
	}
	if got := callRoute(t, nil, http.MethodPost, "/things", `{"name":"a"}`); !strings.Contains(got.body, `"note":null`) {
		t.Fatalf("missing pointer field: got %d %s", got.code, got.body)
	}
}

func TestBodyErrors(t *testing.T) {
	cases := []struct {
		name, body, part string
	}{
		{"unknown field", `{"name":"a","note":null,"colour":"red"}`, `unknown field "colour"`},
		{"wrong type", `{"name":5,"note":null}`, `"name" has the wrong type`},
		{"missing required", `{"note":null}`, `"name" is required`},
		{"two values", `{"name":"a"} {"name":"b"}`, "the request body must be one JSON value"},
		{"not JSON", `{"name":`, "the request body is not valid JSON"},
		{"empty", ``, "the request body is not valid JSON"},
		{"too large", `{"name":"` + strings.Repeat("x", maxBody-10) + `"}`, "the request body is larger than 1 MiB"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wantError(t, callRoute(t, nil, http.MethodPost, "/things", c.body), 400, "invalid_request", c.part)
		})
	}
	if n := len(`{"name":"` + strings.Repeat("x", maxBody-10) + `"}`); n != maxBody+1 {
		t.Fatalf("the too-large body is %d bytes, want %d", n, maxBody+1)
	}
}

func TestRowWithoutBodyFieldsIgnoresTheBody(t *testing.T) {
	if got := callRoute(t, nil, http.MethodPost, "/nobody", `not json at all`); got.code != 200 {
		t.Fatalf("got %d %s", got.code, got.body)
	}
}

func TestEnum(t *testing.T) {
	cases := []struct {
		name, path, body string
		ok               bool
		part             string
	}{
		{"inside", "/things", `{"name":"a","mode":"fast"}`, true, ""},
		{"outside", "/things", `{"name":"a","mode":"warp"}`, false, `"mode" must be one of fast, slow`},
		{"nested outside", "/things", `{"name":"a","inner":{"kind":"c"}}`, false, `"inner.kind" must be one of a, b`},
		{"empty with omitempty", "/things", `{"name":"a","mode":""}`, true, ""},
		{"empty without omitempty", "/strict", `{"mode":""}`, false, `"mode" must be one of fast, slow`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := callRoute(t, nil, http.MethodPost, c.path, c.body)
			if c.ok {
				if got.code != 200 {
					t.Fatalf("got %d %s", got.code, got.body)
				}
				return
			}
			wantError(t, got, 400, "invalid_request", c.part)
		})
	}
}

func TestValidate(t *testing.T) {
	wantError(t, callRoute(t, nil, http.MethodPost, "/validated", `{"n":1}`), 409, "too_one", "one is too one")
	wantError(t, callRoute(t, nil, http.MethodPost, "/validated", `{"n":2}`), 400, "invalid_request", "two is not allowed")
	if got := callRoute(t, nil, http.MethodPost, "/validated", `{"n":3}`); got.code != 200 {
		t.Fatalf("got %d %s", got.code, got.body)
	}
}

func TestSuccessStatuses(t *testing.T) {
	if got := callRoute(t, nil, http.MethodPost, "/accepted", ""); got.code != 202 || got.body != `{"status":"accepted"}`+"\n" {
		t.Fatalf("WithStatus: got %d %s", got.code, got.body)
	}
	var logBuf bytes.Buffer
	rec := httptest.NewRecorder()
	newMux(testRoutes(nil), slog.New(slog.NewTextHandler(&logBuf, nil))).ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/gone", nil))
	if rec.Code != 204 || rec.Body.Len() != 0 || rec.Header().Get("Content-Type") != "" {
		t.Fatalf("NoContent: got %d %q, content type %q", rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}
}

func TestErrorMapping(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{&config.InvalidError{Message: "n must not be negative"}, 400, "invalid_config"},
		{config.ErrUnknownSection, 404, "unknown_section"},
		{config.ErrConflict, 409, "config_conflict"},
		{config.ErrUnavailable, 503, "config_unavailable"},
		{catalog.ErrUnknown, 404, "unknown_model"},
		{downloads.ErrUnknown, 404, "unknown_model"},
		{catalog.ErrNoFolder, 409, "no_models_folder"},
		{downloads.ErrNoFolder, 409, "no_models_folder"},
		{downloads.ErrNoDownload, 404, "no_download"},
		{downloads.ErrInstalled, 409, "already_installed"},
		{downloads.ErrNoSpace, 409, "not_enough_space"},
		{downloads.ErrNotResumable, 409, "not_paused"},
		{router.ErrUnknownModel, 404, "model_not_found"},
		{router.ErrNoEmbeddingModel, 409, "no_embedding_model"},
		{store.ErrNotFound, 404, "chat_not_found"},
		{fmt.Errorf("%w: the message is empty", chat.ErrBadInput), 400, "bad_request"},
	}
	for _, c := range cases {
		t.Run(c.code+" "+c.err.Error(), func(t *testing.T) {
			got := callRoute(t, fmt.Errorf("wrapped: %w", c.err), http.MethodGet, "/fail", "")
			wantError(t, got, c.status, c.code, "")
		})
	}
}

func TestErrorExtraGoesInTheBody(t *testing.T) {
	err := &Error{Status: 409, Code: "config_conflict", Message: "changed", Extra: map[string]any{"current": map[string]int{"rev": 3}}}
	got := callRoute(t, err, http.MethodGet, "/fail", "")
	wantError(t, got, 409, "config_conflict", "changed")
	if !strings.Contains(got.body, `"current":{"rev":3}`) {
		t.Fatalf("body = %s", got.body)
	}
}

func TestUnmappedErrorIsInternalAndLogged(t *testing.T) {
	got := callRoute(t, errors.New("disk on fire"), http.MethodGet, "/fail", "")
	wantError(t, got, 500, "internal", "core hit an unexpected error")
	if strings.Contains(got.body, "disk on fire") {
		t.Fatalf("the cause leaked into the body: %s", got.body)
	}
	if !strings.Contains(got.log, "request failed") || !strings.Contains(got.log, "op=fail") || !strings.Contains(got.log, "disk on fire") {
		t.Fatalf("log = %q", got.log)
	}
}

func TestCancelledRequestWritesNoBody(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := callRouteCtx(t, ctx, context.Canceled, http.MethodGet, "/fail", ""); got.body != "" {
		t.Fatalf("body = %q, want none", got.body)
	}
}

func TestNewMuxPanicsOnRepeats(t *testing.T) {
	ok := func(context.Context, struct{}) (struct{}, error) { return struct{}{}, nil }
	cases := map[string][]Route{
		"method and path": {JSON(http.MethodGet, "/a", UI, "one", "", ok), JSON(http.MethodGet, "/a", UI, "two", "", ok)},
		"operation id":    {JSON(http.MethodGet, "/a", UI, "one", "", ok), JSON(http.MethodGet, "/b", UI, "one", "", ok)},
	}
	for name, routes := range cases {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("newMux did not panic")
				}
			}()
			newMux(routes, nil)
		})
	}
}

func TestTagFromPath(t *testing.T) {
	cases := map[string]string{
		"/api/models/{id}/load": "models",
		"/api/openapi.json":     "openapi",
		"/v1/models":            "openai",
		"/health":               "core",
	}
	for path, want := range cases {
		if got := Raw(http.MethodGet, path, UI, "x", "", nil).Tag; got != want {
			t.Errorf("Tag(%s) = %q, want %q", path, got, want)
		}
	}
}
