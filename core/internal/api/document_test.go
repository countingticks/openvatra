package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
)

func decodeDoc(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// at walks nested maps and slices by key or index.
func at(t *testing.T, v any, path ...any) any {
	t.Helper()
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				t.Fatalf("%v: not an object at %q", path, k)
			}
			if v, ok = m[k]; !ok {
				t.Fatalf("%v: no key %q", path, k)
			}
		case int:
			a, ok := v.([]any)
			if !ok || k >= len(a) {
				t.Fatalf("%v: no index %d", path, k)
			}
			v = a[k]
		}
	}
	return v
}

func TestEveryEventTypeIsDocumented(t *testing.T) {
	for _, p := range event.Types {
		n := 0
		for _, d := range eventDocs {
			if d.Type == p.EventType() {
				n++
			}
		}
		if n != 1 {
			t.Errorf("%s has %d eventDocs rows, want 1", p.EventType().Name, n)
		}
	}
	for _, d := range eventDocs {
		if !slices.ContainsFunc(event.Types, func(p event.Payload) bool { return p.EventType() == d.Type }) {
			t.Errorf("eventDocs row %s is not in event.Types", d.Type.Name)
		}
	}
}

func TestDocumentListsEveryRoute(t *testing.T) {
	doc := decodeDoc(t, Document(Deps{}))
	for _, rt := range Routes(Deps{}) {
		op := at(t, doc, "paths", rt.Path, strings.ToLower(rt.Method))
		if got := at(t, op, "operationId"); got != rt.OperationID {
			t.Errorf("%s %s: operationId %v, want %s", rt.Method, rt.Path, got, rt.OperationID)
		}
		if got := at(t, op, "x-scope"); got != scopeNames[rt.Scope] {
			t.Errorf("%s: x-scope %v, want %s", rt.OperationID, got, scopeNames[rt.Scope])
		}
	}
}

func TestDocumentEvents(t *testing.T) {
	doc := decodeDoc(t, Document(Deps{}))
	schemas := at(t, doc, "components", "schemas")
	if n := len(at(t, schemas, "Event", "oneOf").([]any)); n != 3 {
		t.Errorf("Event.oneOf has %d branches, want 3", n)
	}
	for _, name := range []string{"ConfigChangedEvent", "ModelStateEvent", "DownloadProgressEvent"} {
		at(t, schemas, name)
	}
	if got := at(t, schemas, "ModelStateEvent", "properties", "type", "enum"); !slices.Equal(anyStrings(got), []string{"model.state"}) {
		t.Errorf("ModelStateEvent type enum = %v", got)
	}
	if got := at(t, schemas, "ModelStateEvent", "properties", "data", "$ref"); got != "#/components/schemas/StateBody" {
		t.Errorf("ModelStateEvent data = %v", got)
	}
	var names []string
	for _, p := range at(t, doc, "paths", "/api/events", "get", "parameters").([]any) {
		names = append(names, at(t, p, "name").(string))
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"after", "log", "stream"}) {
		t.Errorf("/api/events parameters = %v", names)
	}
}

func anyStrings(v any) []string {
	var out []string
	for _, s := range v.([]any) {
		out = append(out, s.(string))
	}
	return out
}

func TestDocumentConfigSection(t *testing.T) {
	cfg := config.New(nil, nil)
	config.Register(cfg, config.ModelsSection, config.DefaultModels(),
		func(config.Models) config.ModelsEffective { return config.ModelsEffective{} })
	doc := decodeDoc(t, Document(Deps{Config: cfg}))
	ok := at(t, doc, "paths", "/api/config/models", "get", "responses", "200", "content", "application/json", "schema", "properties")
	if got := at(t, ok, "value", "$ref"); got != "#/components/schemas/Models" {
		t.Errorf("value = %v", got)
	}
	if got := at(t, ok, "effective", "$ref"); got != "#/components/schemas/ModelsEffective" {
		t.Errorf("effective = %v", got)
	}
	body := at(t, doc, "paths", "/api/config/models", "put", "requestBody", "content", "application/json", "schema", "properties")
	at(t, body, "rev")
	at(t, body, "value")
}

func TestDocumentModelSchema(t *testing.T) {
	props := at(t, decodeDoc(t, Document(Deps{})), "components", "schemas", "Model", "properties").(map[string]any)
	for _, k := range []string{"id", "state", "busy", "error", "sizeBytes", "kind"} {
		if _, ok := props[k]; !ok {
			t.Errorf("Model has no %q property", k)
		}
	}
}

func TestDocumentIsDeterministic(t *testing.T) {
	d := Deps{Config: configStore(t, false), Version: "1.2.3"}
	if !bytes.Equal(Document(d), Document(d)) {
		t.Error("two calls gave different bytes")
	}
}

func TestOpenapiRoute(t *testing.T) {
	d := Deps{Version: "9.9.9"}
	req := httptest.NewRequest(http.MethodGet, "/api/openapi.json", nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	testHandler(d).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("status %d, content type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !bytes.Equal(rec.Body.Bytes(), Document(d)) {
		t.Error("body differs from Document")
	}
}
