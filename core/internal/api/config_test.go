package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/store"
)

// configStore is a real config store with the models section; withDB false = no database (config.New(nil, …)).
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
	config.Register(cfg, config.ModelsSection, config.DefaultModels(), func(m config.Models) any {
		return map[string]any{"idleUnloadMinutes": 15}
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

const modelsValue = `{"idleUnloadMinutes":30,"options":{},"engine":"bundled"}`

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
	models, ok := list.Sections["models"]
	if !ok || models.Rev != 0 || !strings.Contains(string(models.Value), `"idleUnloadMinutes":15`) || len(models.Effective) == 0 {
		t.Fatalf("models entry = %+v", models)
	}

	rec = configCall(t, cfg, http.MethodGet, "/api/config/models", "")
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
		body := `{"rev":` + strconv.Itoa(rev) + `,"value":` + modelsValue + `}`
		return configCall(t, cfg, http.MethodPut, "/api/config/models", body)
	}
	rec := put(0)
	if got := decodeEntry(t, rec.Body.String()); rec.Code != http.StatusOK || got.Rev != 1 {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	rec = configCall(t, cfg, http.MethodGet, "/api/config/models", "")
	if got := decodeEntry(t, rec.Body.String()); got.Rev != 1 || !strings.Contains(string(got.Value), `"idleUnloadMinutes":30`) {
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
		{"unknown field in value", "/api/config/models", `{"rev":0,"value":{"idleUnloadMinutes":15,"options":{},"engine":"bundled","bogus":1}}`, 400, "invalid_request", "bogus"},
		{"wrong type in value", "/api/config/models", `{"rev":0,"value":{"idleUnloadMinutes":"soon"}}`, 400, "invalid_request", "idleUnloadMinutes"},
		{"idle minutes 0", "/api/config/models", `{"rev":0,"value":{"idleUnloadMinutes":0,"options":{},"engine":"bundled"}}`, 400, "invalid_config", "idleUnloadMinutes"},
		{"not JSON", "/api/config/models", `nope`, 400, "invalid_request", "not valid JSON"},
		{"no rev", "/api/config/models", `{"value":{}}`, 400, "invalid_request", `"rev" is required`},
		{"negative rev", "/api/config/models", `{"rev":-1,"value":{}}`, 400, "invalid_config", "the body must be"},
		{"no value", "/api/config/models", `{"rev":0}`, 400, "invalid_request", `"value" is required`},
		{"unknown top-level field", "/api/config/models", `{"rev":0,"value":{},"x":1}`, 400, "invalid_request", `"x"`},
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
	rec := configCall(t, cfg, http.MethodPut, "/api/config/models", `{"rev":0,"value":`+modelsValue+`}`)
	if rec.Code != http.StatusServiceUnavailable || errorBody(t, rec)["error"] != "config_unavailable" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestConfigRoutesNeedTheToken(t *testing.T) {
	cfg := configStore(t, true)
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/config"},
		{http.MethodGet, "/api/config/models"},
		{http.MethodPut, "/api/config/models"},
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
	if rec := configCall(t, nil, http.MethodGet, "/api/config/models", ""); rec.Code != http.StatusNotFound {
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
		"GET /api/config/models getConfigModels",
		"PUT /api/config/models putConfigModels",
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
