package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/store"
)

// testModels is a section like the model ones: path is shell-only, n must be positive.
type testModels struct {
	Path *string `json:"path"`
	N    int     `json:"n"`
}

func (v testModels) Validate() error {
	if err := config.ValidatePath("path", v.Path); err != nil {
		return err
	}
	if v.N < 1 {
		return errors.New("n must be positive")
	}
	return nil
}

func (testModels) ShellOnly() []string { return []string{"path"} }

const testSection = "engine.test"

// configStore is a real config store with the engine.test section; withDB false = no database (config.New(nil, …)).
func configStore(t *testing.T, withDB bool) *config.Store {
	t.Helper()
	var db config.DB
	if withDB {
		st, err := store.Open(t.TempDir(), event.NewBus(16))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { st.Close() })
		db = st
	}
	cfg := config.New(db, nil)
	config.Register(cfg, testSection, testModels{N: 15}, func(m testModels) any {
		return map[string]any{"n": m.N}
	})
	return cfg
}

func configCall(t *testing.T, cfg Config, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	testHandler(t, Deps{Config: cfg}).ServeHTTP(rec, req)
	return rec
}

func decodeEntry(t *testing.T, body string) config.SectionEntry {
	t.Helper()
	var e config.SectionEntry
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatalf("not an entry: %s", body)
	}
	return e
}

func errorBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("not JSON: %s", rec.Body.String())
	}
	return m
}

const testValue = `{"path":null,"n":30}`

func TestConfigListAndGetSection(t *testing.T) {
	cfg := configStore(t, true)
	rec := configCall(t, cfg, http.MethodGet, "/api/config", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var list struct {
		Sections map[string]config.SectionEntry `json:"sections"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	models, ok := list.Sections[testSection]
	if !ok || models.Rev != 0 || !strings.Contains(string(models.Value), `"n":15`) || len(models.Effective) == 0 {
		t.Fatalf("%s entry = %+v", testSection, models)
	}

	rec = configCall(t, cfg, http.MethodGet, "/api/config/engine.test", "")
	got := decodeEntry(t, rec.Body.String())
	if rec.Code != http.StatusOK || got.Rev != 0 || string(got.Value) != string(models.Value) || string(got.Effective) != string(models.Effective) {
		t.Fatalf("section = %d %s", rec.Code, rec.Body)
	}

	// The generic section routes are gone: an unregistered name is not a route.
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		if rec := configCall(t, cfg, method, "/api/config/nope", `{"rev":0,"value":{}}`); rec.Code != http.StatusNotFound {
			t.Fatalf("%s unknown section = %d %s", method, rec.Code, rec.Body)
		}
	}
}

func TestConfigPutAndConflict(t *testing.T) {
	cfg := configStore(t, true)
	put := func(rev int) *httptest.ResponseRecorder {
		body := `{"rev":` + strconv.Itoa(rev) + `,"value":` + testValue + `}`
		return configCall(t, cfg, http.MethodPut, "/api/config/engine.test", body)
	}
	rec := put(0)
	if got := decodeEntry(t, rec.Body.String()); rec.Code != http.StatusOK || got.Rev != 1 {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	rec = configCall(t, cfg, http.MethodGet, "/api/config/engine.test", "")
	if got := decodeEntry(t, rec.Body.String()); got.Rev != 1 || !strings.Contains(string(got.Value), `"n":30`) {
		t.Fatalf("get after put = %s", rec.Body)
	}

	rec = put(0)
	body := errorBody(t, rec)
	current, _ := body["current"].(map[string]any)
	if rec.Code != http.StatusConflict || body["error"] != "config_conflict" || current["rev"] != float64(1) {
		t.Fatalf("conflict = %d %s", rec.Code, rec.Body)
	}
}

func TestConfigPutRejectsBadBodies(t *testing.T) {
	cfg := configStore(t, true)
	tests := []struct {
		name, path, body string
		status           int
		code, mentions   string
	}{
		// Shape errors are the wrapper's (decision 12); the section's own decode and Validate answer invalid_config.
		{"unknown field in value", "/api/config/engine.test", `{"rev":0,"value":{"path":null,"n":15,"bogus":1}}`, 400, "invalid_request", "bogus"},
		{"wrong type in value", "/api/config/engine.test", `{"rev":0,"value":{"n":"soon"}}`, 400, "invalid_request", "n"},
		{"n 0", "/api/config/engine.test", `{"rev":0,"value":{"path":null,"n":0}}`, 400, "invalid_config", "n must be positive"},
		{"not JSON", "/api/config/engine.test", `nope`, 400, "invalid_request", "not valid JSON"},
		{"no rev", "/api/config/engine.test", `{"value":{}}`, 400, "invalid_request", `"rev" is required`},
		{"negative rev", "/api/config/engine.test", `{"rev":-1,"value":` + testValue + `}`, 400, "invalid_config", "the body must be"},
		{"no value", "/api/config/engine.test", `{"rev":0}`, 400, "invalid_request", `"value" is required`},
		{"unknown top-level field", "/api/config/engine.test", `{"rev":0,"value":{},"x":1}`, 400, "invalid_request", `"x"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := configCall(t, cfg, http.MethodPut, tt.path, tt.body)
			body := errorBody(t, rec)
			if rec.Code != tt.status || body["error"] != tt.code || !strings.Contains(body["message"].(string), tt.mentions) {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
		})
	}
}

func TestConfigPutWithoutDatabaseIs503(t *testing.T) {
	cfg := configStore(t, false)
	rec := configCall(t, cfg, http.MethodPut, "/api/config/engine.test", `{"rev":0,"value":`+testValue+`}`)
	if rec.Code != http.StatusServiceUnavailable || errorBody(t, rec)["error"] != "config_unavailable" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestConfigRoutesNeedTheToken(t *testing.T) {
	cfg := configStore(t, true)
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/config"},
		{http.MethodGet, "/api/config/engine.test"},
		{http.MethodPut, "/api/config/engine.test"},
	} {
		req := httptest.NewRequest(r.method, r.path, strings.NewReader(`{"rev":0,"value":{}}`))
		req.Host = "127.0.0.1:53121"
		rec := httptest.NewRecorder()
		testHandler(t, Deps{Config: cfg}).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a token = %d, want 401", r.method, r.path, rec.Code)
		}
	}
}

func TestConfigWithoutStore(t *testing.T) {
	rec := configCall(t, nil, http.MethodGet, "/api/config", "")
	if rec.Code != http.StatusServiceUnavailable || errorBody(t, rec)["error"] != "config_unavailable" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if rec := configCall(t, nil, http.MethodGet, "/api/config/engine.test", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("section route without a store = %d", rec.Code)
	}
}

// otherSection is a second section, to check one route pair per registered section.
type otherSection struct {
	On bool `json:"on"`
}

func (otherSection) Validate() error { return nil }

func TestOneRoutePairPerSection(t *testing.T) {
	cfg := configStore(t, false)
	config.Register[otherSection, struct{}](cfg, "search", otherSection{}, nil)

	var got []string
	for _, r := range Routes(Deps{Config: cfg}) {
		if r.Tag == "config" {
			got = append(got, r.Method+" "+r.Path+" "+r.OperationID)
		}
	}
	want := []string{
		"GET /api/config getConfig",
		"GET /api/config/engine.test getConfigEngineTest",
		"PUT /api/config/engine.test putConfigEngineTest",
		"GET /api/config/search getConfigSearch",
		"PUT /api/config/search putConfigSearch",
	}
	if g, w := strings.Join(got, "\n"), strings.Join(want, "\n"); g != w {
		t.Fatalf("config routes:\n%s\nwant:\n%s", g, w)
	}

	rec := configCall(t, cfg, http.MethodGet, "/api/config/search", "")
	if got := strings.TrimSpace(rec.Body.String()); rec.Code != http.StatusOK || got != `{"rev":0,"value":{"on":false}}` {
		t.Fatalf("GET search = %d %s", rec.Code, got)
	}
}

// configClient is one handler kept across calls, so a ui token issued through POST /api/tokens stays live.
type configClient struct {
	t  *testing.T
	h  http.Handler
	ui string
}

// newConfigClient stores the path with the shell token (rev 1) and issues a ui token.
func newConfigClient(t *testing.T) *configClient {
	t.Helper()
	c := &configClient{t: t, h: testHandler(t, Deps{Config: configStore(t, true)})}
	rec := c.call(testToken, http.MethodPost, "/api/tokens", `{"scope":"ui"}`)
	var tok TokenBody
	if err := json.Unmarshal(rec.Body.Bytes(), &tok); rec.Code != http.StatusCreated || err != nil {
		t.Fatalf("issue = %d %s", rec.Code, rec.Body)
	}
	c.ui = tok.Token
	if rec := c.put(testToken, 0, `"C:/llama/llama-server.exe"`, 15); rec.Code != http.StatusOK {
		t.Fatalf("shell put = %d %s", rec.Code, rec.Body)
	}
	return c
}

func (c *configClient) call(token, method, path, body string) *httptest.ResponseRecorder {
	c.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	return rec
}

// put sends the engine.test section with the given JSON for path, and n.
func (c *configClient) put(token string, rev int, path string, n int) *httptest.ResponseRecorder {
	c.t.Helper()
	body := fmt.Sprintf(`{"rev":%d,"value":{"path":%s,"n":%d}}`, rev, path, n)
	return c.call(token, http.MethodPut, "/api/config/engine.test", body)
}

func (c *configClient) rev() int {
	c.t.Helper()
	return decodeEntry(c.t, c.call(testToken, http.MethodGet, "/api/config/engine.test", "").Body.String()).Rev
}

func TestUITokenMayOnlyResetShellOnlyFields(t *testing.T) {
	const llama = `"C:/llama/llama-server.exe"`
	cases := []struct {
		name   string
		shell  bool
		rev    int
		path   string
		status int
		code   string
	}{
		{"ui changes path", false, 1, `"C:/evil/llama-server.exe"`, 403, "shell_only_field"},
		{"ui sets path to null", false, 1, "null", 200, ""},
		{"ui keeps the path and changes n", false, 1, llama, 200, ""},
		{"ui with a stale rev and a changed path", false, 0, `"C:/evil/llama-server.exe"`, 409, "config_conflict"},
		{"shell changes path", true, 1, `"C:/other/llama-server.exe"`, 200, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newConfigClient(t)
			token := c.ui
			if tc.shell {
				token = testToken
			}
			rec := c.put(token, tc.rev, tc.path, 30)
			if rec.Code != tc.status {
				t.Fatalf("status = %d %s, want %d", rec.Code, rec.Body, tc.status)
			}
			if tc.code != "" && errorBody(t, rec)["error"] != tc.code {
				t.Fatalf("body = %s, want %s", rec.Body, tc.code)
			}
			if tc.status == 403 {
				if !strings.Contains(rec.Body.String(), "path can only be set by the app") {
					t.Fatalf("message does not name the field: %s", rec.Body)
				}
				if rev := c.rev(); rev != 1 {
					t.Fatalf("stored rev = %d after a refused put, want 1", rev)
				}
			}
		})
	}
}
