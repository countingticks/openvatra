package openapi

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/small.json")

type errBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type listIn struct {
	ID   string   `path:"id"`
	Tags []string `query:"tags" doc:"filter"`
}

type NewThing struct {
	Name string `json:"name"`
	Size *int   `json:"size,omitempty"`
}

type thing struct {
	ID   string `json:"id"`
	Kind string `json:"kind" enum:"a,b"`
}

type patchIn struct {
	ID   string `path:"id"`
	Name string `json:"name"`
}

type idOnly struct {
	ID string `path:"id"`
}

type namedWithPath struct {
	ID   string `path:"id" json:"-"`
	Name string `json:"name"`
}

func ptr[T any](v T) *T { return &v }

func smallOps(r *Reflector) []Operation {
	return []Operation{
		{Method: "GET", Path: "/api/things/{id}", OperationID: "getThing", Summary: "Get one thing", Tag: "things", Scope: "ui",
			In: reflect.TypeOf(listIn{}), Out: reflect.TypeOf(thing{}), Status: 200, Errors: []string{"not_found"}},
		{Method: "POST", Path: "/api/things", OperationID: "createThing", Summary: "Create a thing", Tag: "things", Scope: "ui",
			In: reflect.TypeOf(NewThing{}), Out: reflect.TypeOf(thing{}), Status: 201, Errors: []string{"bad_request", "conflict"}},
		{Method: "POST", Path: "/api/things/{id}/rename", OperationID: "renameThing", Summary: "Rename", Tag: "things", Scope: "ui",
			In: reflect.TypeOf(patchIn{}), Status: 200},
		{Method: "DELETE", Path: "/api/things/{id}", OperationID: "deleteThing", Summary: "Delete", Tag: "things", Scope: "shell",
			In: reflect.TypeOf(idOnly{}), Status: 204},
		{Method: "GET", Path: "/api/events", OperationID: "streamEvents", Summary: "Event stream", Tag: "events", Scope: "ui",
			OutSchema: &Schema{Type: "string"}, Status: 200, ContentType: "text/event-stream"},
		{Method: "POST", Path: "/api/shutdown", OperationID: "shutdown", Summary: "Stop core", Tag: "system", Scope: "shell", Status: 202},
	}
}

func build(ops func(*Reflector) []Operation) []byte {
	r := NewReflector()
	return Build(Info{Title: "OpenVatra core", Version: "1.2.3", APILevel: 4}, ops(r), r, reflect.TypeOf(errBody{}))
}

func norm(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }

func TestBuildMatchesGolden(t *testing.T) {
	got := build(smallOps)
	const path = "testdata/small.json"
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if norm(got) != norm(want) {
		t.Errorf("document differs from %s; run go -C core test ./internal/api/openapi -update", path)
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	if !bytes.Equal(build(smallOps), build(smallOps)) {
		t.Error("two builds differ")
	}
}

func TestBuildFormat(t *testing.T) {
	got := build(func(*Reflector) []Operation {
		return []Operation{{Method: "GET", Path: "/b", OperationID: "b", Summary: "a < b & c", Tag: "t", Scope: "none", Status: 200},
			{Method: "GET", Path: "/a", OperationID: "a", Summary: "x", Tag: "t", Scope: "none", Status: 200}}
	})
	s := string(got)
	if !strings.HasSuffix(s, "}\n") || strings.HasSuffix(s, "\n\n") {
		t.Error("output must end in exactly one newline")
	}
	if !strings.Contains(s, "a < b & c") {
		t.Error("summary was HTML-escaped")
	}
	if strings.Index(s, `"/a"`) > strings.Index(s, `"/b"`) {
		t.Error("paths are not sorted")
	}
	if strings.Index(s, `"components"`) > strings.Index(s, `"openapi"`) {
		t.Error("top-level keys are not sorted")
	}
}

func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func dig(t *testing.T, m any, keys ...string) any {
	t.Helper()
	for _, k := range keys {
		next, ok := m.(map[string]any)[k]
		if !ok {
			t.Fatalf("missing %s", k)
		}
		m = next
	}
	return m
}

func TestNamedBodyWithPathFieldIsInline(t *testing.T) {
	doc := decode(t, build(func(*Reflector) []Operation {
		return []Operation{{Method: "POST", Path: "/x/{id}", OperationID: "x", Tag: "t", Scope: "ui",
			In: reflect.TypeOf(namedWithPath{}), Status: 200}}
	}))
	schema := dig(t, doc, "paths", "/x/{id}", "post", "requestBody", "content", "application/json", "schema").(map[string]any)
	if _, isRef := schema["$ref"]; isRef {
		t.Error("body with a path field should be inline")
	}
	if _, ok := dig(t, schema, "properties").(map[string]any)["name"]; !ok {
		t.Error("inline body lacks name")
	}
	if _, ok := dig(t, doc, "paths", "/x/{id}", "post").(map[string]any)["parameters"]; !ok {
		t.Error("path parameter missing")
	}
}

func TestDefaultResponseDescription(t *testing.T) {
	cases := []struct {
		name   string
		errors []string
		want   string
	}{
		{"codes", []string{"a", "b"}, "Error. Codes: a, b."},
		{"none", nil, "Error."},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc := decode(t, build(func(*Reflector) []Operation {
				return []Operation{{Method: "GET", Path: "/x", OperationID: "x", Tag: "t", Scope: "none", Status: http.StatusOK, Errors: c.errors}}
			}))
			if got := dig(t, doc, "paths", "/x", "get", "responses", "default", "description"); got != c.want {
				t.Errorf("description = %v, want %q", got, c.want)
			}
		})
	}
}
