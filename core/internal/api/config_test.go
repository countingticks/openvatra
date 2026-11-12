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
	NewHandler(testToken, testPort, func() {}, nil, nil, cfg, stubHardware{}, stubCatalog{}, nil, nil).ServeHTTP(rec, req)
	return rec
}

func decodeEntry(t *testing.T, body string) config.Entry {
	t.Helper()
	var e config.Entry
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
		Sections map[string]config.Entry `json:"sections"`
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

	rec = configCall(t, cfg, http.MethodGet, "/api/config/nope", "")
	if rec.Code != http.StatusNotFound || errorBody(t, rec)["error"] != "unknown_section" {
		t.Fatalf("unknown section = %d %s", rec.Code, rec.Body)
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
		{"unknown field in value", "/api/config/models", `{"rev":0,"value":{"idleUnloadMinutes":15,"options":{},"engine":"bundled","bogus":1}}`, 400, "invalid_config", "bogus"},
		{"idle minutes 0", "/api/config/models", `{"rev":0,"value":{"idleUnloadMinutes":0,"options":{},"engine":"bundled"}}`, 400, "invalid_config", "idleUnloadMinutes"},
		{"not JSON", "/api/config/models", `nope`, 400, "invalid_config", "the body must be"},
		{"no rev", "/api/config/models", `{"value":{}}`, 400, "invalid_config", "the body must be"},
		{"negative rev", "/api/config/models", `{"rev":-1,"value":{}}`, 400, "invalid_config", "the body must be"},
		{"no value", "/api/config/models", `{"rev":0}`, 400, "invalid_config", "the body must be"},
		{"unknown top-level field", "/api/config/models", `{"rev":0,"value":{},"x":1}`, 400, "invalid_config", "the body must be"},
		{"unknown section", "/api/config/nope", `{"rev":0,"value":{}}`, 404, "unknown_section", "nope"},
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
		NewHandler(testToken, testPort, func() {}, nil, nil, cfg, stubHardware{}, stubCatalog{}, nil, nil).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a token = %d, want 401", r.method, r.path, rec.Code)
		}
	}
}
