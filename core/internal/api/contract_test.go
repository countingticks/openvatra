package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// tester is the part of *testing.T checkRoutes reports through, so a test can watch it fail.
type tester interface {
	Helper()
	Errorf(format string, args ...any)
}

// checked returns NewHandler(d) wrapped so every JSON response is validated against Document(d); a mismatch is a
// t.Errorf naming the operationId, the status and the JSON path of the first difference. A request from httptest's
// default remote address (192.0.2.1:1234) is sent as 127.0.0.1:1234, so it passes the gate's loopback check.
func checked(t *testing.T, d Deps) http.Handler {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(Document(d), &doc); err != nil {
		t.Fatal(err)
	}
	h := checkRoutes(t, Routes(d), doc, NewHandler(d))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RemoteAddr == "192.0.2.1:1234" {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		h.ServeHTTP(w, r)
	})
}

func checkRoutes(t tester, routes []Route, doc map[string]any, next http.Handler) http.Handler {
	mux := http.NewServeMux()
	byPattern := map[string]Route{}
	for _, rt := range routes {
		pattern := rt.Method + " " + rt.Path
		byPattern[pattern] = rt
		mux.HandleFunc(pattern, func(http.ResponseWriter, *http.Request) {})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		rt, ok := byPattern[pattern]
		// Raw rows without a documented output (streams, proxy, export, shutdown, openapi) go through unbuffered.
		if !ok || (rt.handle != nil && rt.Out == nil) {
			next.ServeHTTP(w, r)
			return
		}
		rec := httptest.NewRecorder()
		next.ServeHTTP(rec, r)
		if err := checkResponse(doc, rt, rec); err != nil {
			t.Helper()
			t.Errorf("%s %d: %v", rt.OperationID, rec.Code, err)
		}
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	})
}

func checkResponse(doc map[string]any, rt Route, rec *httptest.ResponseRecorder) error {
	op, _ := lookup(doc, "paths", rt.Path, strings.ToLower(rt.Method)).(map[string]any)
	if op == nil {
		return fmt.Errorf("not in the document")
	}
	if rec.Code == rt.Status {
		if rt.Status == http.StatusNoContent {
			if rec.Body.Len() != 0 {
				return fmt.Errorf("a 204 has a body")
			}
			return nil
		}
		schema := lookup(op, "responses", strconv.Itoa(rt.Status), "content", "application/json", "schema")
		return validateBody(doc, schema, rec.Body.Bytes())
	}
	schema := lookup(op, "responses", "default", "content", "application/json", "schema")
	if err := validateBody(doc, schema, rec.Body.Bytes()); err != nil {
		return err
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if !slices.Contains(append([]string{"internal", "unauthorized", "forbidden_remote", "forbidden_host", "forbidden_origin",
		"forbidden_scope"}, rt.Errors...), body.Error) {
		return fmt.Errorf("error code %q is not in the route's Errors %v", body.Error, rt.Errors)
	}
	return nil
}

func validateBody(doc map[string]any, schema any, body []byte) error {
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return fmt.Errorf("body is not JSON: %w", err)
	}
	return validate(doc, schema, v, "$")
}

func lookup(v any, path ...string) any {
	for _, p := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[p]
	}
	return v
}

// validate checks value (decoded JSON) against schema, resolving $ref in doc. Returns nil or the first mismatch.
func validate(doc map[string]any, schema any, value any, path string) error {
	s, ok := schema.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: no schema", path)
	}
	if ref, ok := s["$ref"].(string); ok {
		target := lookup(doc, strings.Split(strings.TrimPrefix(ref, "#/"), "/")...)
		if target == nil {
			return fmt.Errorf("%s: unresolved %s", path, ref)
		}
		return validate(doc, target, value, path)
	}
	if enum, ok := s["enum"].([]any); ok && !slices.Contains(enum, value) {
		return fmt.Errorf("%s: %s is not one of %s", path, describe(value), describe(enum))
	}
	if branches, ok := s["oneOf"].([]any); ok {
		n := 0
		for _, b := range branches {
			if validate(doc, b, value, path) == nil {
				n++
			}
		}
		if n != 1 {
			return fmt.Errorf("%s: matches %d of the %d oneOf branches, want 1", path, n, len(branches))
		}
		return nil
	}
	typ, ok := s["type"]
	if !ok {
		return nil
	}
	var types []string
	switch t := typ.(type) {
	case string:
		types = []string{t}
	case []any:
		for _, x := range t {
			types = append(types, x.(string))
		}
	}
	var first error
	for _, t := range types {
		err := validateType(doc, s, t, value, path)
		if err == nil {
			return nil
		}
		if first == nil {
			first = err
		}
	}
	return first
}

func validateType(doc, s map[string]any, typ string, value any, path string) error {
	mismatch := func() error { return fmt.Errorf("%s: %s is not %s", path, describe(value), typ) }
	switch typ {
	case "null":
		if value != nil {
			return mismatch()
		}
	case "string":
		if _, ok := value.(string); !ok {
			return mismatch()
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return mismatch()
		}
	case "number":
		if _, ok := value.(float64); !ok {
			return mismatch()
		}
	case "integer":
		f, ok := value.(float64)
		if !ok || f != math.Trunc(f) {
			return mismatch()
		}
	case "array":
		items, ok := value.([]any)
		if !ok {
			return mismatch()
		}
		for i, item := range items {
			if err := validate(doc, s["items"], item, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case "object":
		m, ok := value.(map[string]any)
		if !ok {
			return mismatch()
		}
		props, _ := s["properties"].(map[string]any)
		if req, ok := s["required"].([]any); ok {
			for _, k := range req {
				if _, ok := m[k.(string)]; !ok {
					return fmt.Errorf("%s: missing required %q", path, k)
				}
			}
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			sub := path + "." + k
			if p, ok := props[k]; ok {
				if err := validate(doc, p, m[k], sub); err != nil {
					return err
				}
			} else if extra, ok := s["additionalProperties"]; ok {
				if err := validate(doc, extra, m[k], sub); err != nil {
					return err
				}
			} else {
				return fmt.Errorf("%s: unknown key %q", path, k)
			}
		}
	default:
		return fmt.Errorf("%s: unsupported type %q", path, typ)
	}
	return nil
}

func describe(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestContractValidate(t *testing.T) {
	doc := map[string]any{"components": map[string]any{"schemas": map[string]any{
		"Thing": map[string]any{"type": "object", "properties": map[string]any{"n": map[string]any{"type": "integer"}}},
	}}}
	parse := func(s string) any {
		var v any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	cases := []struct {
		name, schema, value string
		bad                 bool
	}{
		{"matching object", `{"type":"object","required":["a"],"properties":{"a":{"type":"string"},"n":{"type":"integer"}}}`, `{"a":"x","n":2}`, false},
		{"missing required key", `{"type":"object","required":["a"],"properties":{"a":{"type":"string"}}}`, `{}`, true},
		{"unknown key", `{"type":"object","properties":{"a":{"type":"string"}}}`, `{"a":"x","b":1}`, true},
		{"string for integer", `{"type":"integer"}`, `"1"`, true},
		{"fraction for integer", `{"type":"integer"}`, `1.5`, true},
		{"null for non-nullable", `{"type":"string"}`, `null`, true},
		{"outside enum", `{"type":"string","enum":["a","b"]}`, `"c"`, true},
		{"no oneOf branch", `{"oneOf":[{"type":"string"},{"type":"integer"}]}`, `true`, true},
		{"one oneOf branch", `{"oneOf":[{"type":"string"},{"type":"integer"}]}`, `1`, false},
		{"null for nullable", `{"type":["string","null"]}`, `null`, false},
		{"additionalProperties", `{"type":"object","additionalProperties":{"type":"integer"}}`, `{"a":1,"b":"x"}`, true},
		{"array items", `{"type":"array","items":{"type":"integer"}}`, `[1,"x"]`, true},
		{"any", `{}`, `{"a":[1]}`, false},
		{"follows $ref", `{"$ref":"#/components/schemas/Thing"}`, `{"n":1}`, false},
		{"$ref mismatch", `{"$ref":"#/components/schemas/Thing"}`, `{"n":"x"}`, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := validate(doc, parse(c.schema), parse(c.value), "$")
			if (err != nil) != c.bad {
				t.Errorf("error = %v, want a failure: %v", err, c.bad)
			}
		})
	}
}

type recordingT struct{ errs []string }

func (*recordingT) Helper() {}
func (r *recordingT) Errorf(format string, args ...any) {
	r.errs = append(r.errs, fmt.Sprintf(format, args...))
}

func TestCheckedRejectsAnUndeclaredErrorCode(t *testing.T) {
	routes := []Route{
		JSON(http.MethodGet, "/api/x", UI, "getX", "x",
			func(context.Context, struct{}) (StatusBody, error) {
				return StatusBody{}, &Error{Status: http.StatusTeapot, Code: "teapot", Message: "no"}
			}).WithErrors("declared"),
	}
	var doc map[string]any
	if err := json.Unmarshal(documentOf(routes, "test"), &doc); err != nil {
		t.Fatal(err)
	}
	rec := &recordingT{}
	w := httptest.NewRecorder()
	checkRoutes(rec, routes, doc, newMux(routes, nil)).ServeHTTP(w, asShell(httptest.NewRequest(http.MethodGet, "/api/x", nil)))
	if len(rec.errs) != 1 || !strings.Contains(rec.errs[0], "teapot") || !strings.Contains(rec.errs[0], "getX") {
		t.Errorf("errors = %q, want one naming getX and teapot", rec.errs)
	}
	if w.Code != http.StatusTeapot || !bytes.Contains(w.Body.Bytes(), []byte("teapot")) {
		t.Errorf("response not passed on: %d %s", w.Code, w.Body)
	}
}
