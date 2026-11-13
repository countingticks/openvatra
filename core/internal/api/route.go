package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/countingticks/openvatra/core/internal/api/openapi"
)

// Scope is who may call a route. The gate finds the caller's; newMux compares it with the row's.
type Scope int

const (
	None  Scope = iota // /health only: the gate's loopback and Host checks
	UI                 // the renderer, and any surface later
	Shell              // main: everything UI has, plus starting programs, tokens, shutdown
)

// Route is one row of core's HTTP contract.
type Route struct {
	Method, Path string
	Scope        Scope
	Summary      string
	OperationID  string
	Tag          string       // derived from Path
	In, Out      reflect.Type // nil when there is no input or no JSON output
	Status       int          // success status
	ContentType  string       // "" = application/json
	Errors       []string     // codes this route can answer
	Stream       *StreamDoc   // set for text/event-stream rows
	handle       http.HandlerFunc
	call         func(ctx context.Context, in any) (any, error) // JSON rows; nil for Raw ones
}

// StreamDoc documents a text/event-stream response. A nil Schema documents the content type only.
type StreamDoc struct {
	Schema func(r *openapi.Reflector) *openapi.Schema
}

// NoContent is the Out of a route that answers with no body.
type NoContent struct{}

const maxBody = 1 << 20

var noContentType = reflect.TypeFor[NoContent]()

// JSON declares a JSON-in, JSON-out route: the wrapper decodes and validates In, calls fn, and writes Out or the
// error.
func JSON[In, Out any](method, path string, scope Scope, op, summary string,
	fn func(ctx context.Context, in In) (Out, error)) Route {
	return jsonRoute(method, path, scope, op, summary, reflect.TypeFor[In](), reflect.TypeFor[Out](),
		func(ctx context.Context, in any) (any, error) { return fn(ctx, in.(In)) })
}

// jsonRoute is JSON without generics, for routes whose types are built at runtime. fn gets a value of type in.
func jsonRoute(method, path string, scope Scope, op, summary string, in, out reflect.Type,
	fn func(ctx context.Context, in any) (any, error)) Route {
	if in.Kind() != reflect.Struct {
		panic(fmt.Sprintf("route %s: In must be a struct, not %v", op, in))
	}
	status := http.StatusOK
	if out == noContentType {
		status = http.StatusNoContent
	}
	return Route{Method: method, Path: path, Scope: scope, Summary: summary, OperationID: op, Tag: tagOf(path),
		In: in, Out: out, Status: status, call: fn}
}

// Raw declares a route that writes its own response (streams, the OpenAI proxy, the chat export).
func Raw(method, path string, scope Scope, op, summary string, h http.HandlerFunc) Route {
	return Route{Method: method, Path: path, Scope: scope, Summary: summary, OperationID: op, Tag: tagOf(path),
		Status: http.StatusOK, handle: h}
}

func (rt Route) WithStatus(code int) Route { rt.Status = code; return rt }

func (rt Route) WithErrors(codes ...string) Route {
	rt.Errors = append(slices.Clip(rt.Errors), codes...)
	return rt
}

// WithDoc gives a Raw row its input, output and content type, for the document only.
func (rt Route) WithDoc(in, out reflect.Type, contentType string) Route {
	rt.In, rt.Out, rt.ContentType = in, out, contentType
	return rt
}

func (rt Route) WithStream(doc StreamDoc) Route {
	rt.Stream, rt.ContentType = &doc, "text/event-stream"
	return rt
}

// tagOf groups routes by path: /api/<seg>/… is <seg>, /v1/… is openai, anything else core.
func tagOf(path string) string {
	if rest, ok := strings.CutPrefix(path, "/api/"); ok {
		seg, _, _ := strings.Cut(rest, "/")
		return strings.TrimSuffix(seg, ".json")
	}
	if strings.HasPrefix(path, "/v1/") {
		return "openai"
	}
	return "core"
}

// newMux registers every row on one ServeMux. A repeated method and path or OperationID is a wiring bug and panics.
func newMux(routes []Route, logger *slog.Logger) *http.ServeMux {
	if logger == nil {
		logger = discard
	}
	mux := http.NewServeMux()
	patterns, ops := map[string]bool{}, map[string]bool{}
	for _, rt := range routes {
		pattern := rt.Method + " " + rt.Path
		if patterns[pattern] {
			panic(fmt.Sprintf("route %q declared twice", pattern))
		}
		if ops[rt.OperationID] {
			panic(fmt.Sprintf("operation id %q declared twice", rt.OperationID))
		}
		patterns[pattern], ops[rt.OperationID] = true, true

		h := rt.handle
		if rt.call != nil {
			h = rt.serveJSON
		}
		info := requestInfo{logger: logger, op: rt.OperationID}
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(context.WithValue(r.Context(), requestInfoKey{}, info))
			if !covers(callerScope(r.Context()), rt.Scope) {
				writeError(w, r, &Error{Status: http.StatusForbidden, Code: "forbidden_scope", Message: "this token may not call this route"})
				return
			}
			h(w, r)
		})
	}
	return mux
}

// serveJSON is the wrapper of a JSON row: decode, validate, call, encode.
func (rt Route) serveJSON(w http.ResponseWriter, r *http.Request) {
	in, err := decodeIn(w, r, rt.In)
	if err != nil {
		writeError(w, r, err)
		return
	}
	out, err := rt.call(r.Context(), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if rt.Out == noContentType {
		w.WriteHeader(rt.Status)
		return
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(out); err != nil {
		writeError(w, r, fmt.Errorf("encode %s: %w", rt.OperationID, err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(rt.Status)
	_, _ = w.Write(buf.Bytes())
}

func invalidRequest(format string, args ...any) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: fmt.Sprintf(format, args...)}
}

// bodyField is one top-level field read from the body.
type bodyField struct {
	name     string
	required bool
}

// bodyFields lists the struct's body fields: exported, without a path or query tag, not json:"-". Embedded structs
// without a json name are flattened, as encoding/json does.
func bodyFields(t reflect.Type) []bodyField {
	var out []bodyField
	for i := 0; i < t.NumField(); i++ {
		sf := t.Field(i)
		jsonTag := sf.Tag.Get("json")
		if jsonTag == "-" {
			continue
		}
		if _, ok := sf.Tag.Lookup("path"); ok {
			continue
		}
		if _, ok := sf.Tag.Lookup("query"); ok {
			continue
		}
		name, opts, _ := strings.Cut(jsonTag, ",")
		if sf.Anonymous && name == "" && sf.Type.Kind() == reflect.Struct {
			out = append(out, bodyFields(sf.Type)...)
			continue
		}
		if !sf.IsExported() {
			continue
		}
		if name == "" {
			name = sf.Name
		}
		omit := slices.Contains(strings.Split(opts, ","), "omitempty")
		out = append(out, bodyField{name: name, required: !omit && sf.Type.Kind() != reflect.Pointer})
	}
	return out
}

// decodeIn builds a value of type t from the path, the query and the body, and validates it.
func decodeIn(w http.ResponseWriter, r *http.Request, t reflect.Type) (any, error) {
	v := reflect.New(t).Elem()
	query := r.URL.Query()
	for i := 0; i < t.NumField(); i++ {
		sf := t.Field(i)
		if name, ok := sf.Tag.Lookup("path"); ok {
			if err := setParam(v.Field(i), r.PathValue(name), "path parameter", name); err != nil {
				return nil, err
			}
		} else if name, ok := sf.Tag.Lookup("query"); ok && query.Has(name) {
			if err := setParam(v.Field(i), query.Get(name), "query parameter", name); err != nil {
				return nil, err
			}
		}
	}

	if fields := bodyFields(t); len(fields) > 0 {
		if err := decodeBody(w, r, v, fields); err != nil {
			return nil, err
		}
		if err := checkEnums(v, ""); err != nil {
			return nil, err
		}
	}

	var validator interface{ Validate() error }
	switch {
	case v.Type().Implements(reflect.TypeFor[interface{ Validate() error }]()):
		validator = v.Interface().(interface{ Validate() error })
	case v.Addr().Type().Implements(reflect.TypeFor[interface{ Validate() error }]()):
		validator = v.Addr().Interface().(interface{ Validate() error })
	}
	if validator != nil {
		if err := validator.Validate(); err != nil {
			var e *Error
			if errors.As(err, &e) {
				return nil, e
			}
			return nil, invalidRequest("%s", err.Error())
		}
	}
	return v.Interface(), nil
}

// setParam converts a path or query value into the field's type.
func setParam(f reflect.Value, raw, kind, name string) error {
	if f.Kind() == reflect.Pointer {
		p := reflect.New(f.Type().Elem())
		if err := setParam(p.Elem(), raw, kind, name); err != nil {
			return err
		}
		f.Set(p)
		return nil
	}
	switch f.Kind() {
	case reflect.String:
		f.SetString(raw)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, err := strconv.ParseInt(raw, 10, f.Type().Bits())
		if err != nil {
			return invalidRequest("%s %q must be an integer", kind, name)
		}
		f.SetInt(n)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, err := strconv.ParseUint(raw, 10, f.Type().Bits())
		if err != nil {
			return invalidRequest("%s %q must be an integer", kind, name)
		}
		f.SetUint(n)
	case reflect.Bool:
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return invalidRequest("%s %q must be a boolean", kind, name)
		}
		f.SetBool(b)
	case reflect.Slice:
		if f.Type().Elem().Kind() != reflect.String {
			panic(fmt.Sprintf("%s %q: unsupported type %v", kind, name, f.Type()))
		}
		items := []string{}
		for _, s := range strings.Split(raw, ",") {
			if s != "" {
				items = append(items, s)
			}
		}
		f.Set(reflect.ValueOf(items).Convert(f.Type()))
	default:
		panic(fmt.Sprintf("%s %q: unsupported type %v", kind, name, f.Type()))
	}
	return nil
}

// decodeBody reads one JSON object of at most 1 MiB into v, rejecting unknown and missing fields.
func decodeBody(w http.ResponseWriter, r *http.Request, v reflect.Value, fields []bodyField) error {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return invalidRequest("the request body is larger than 1 MiB")
		}
		return invalidRequest("the request body could not be read")
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v.Addr().Interface()); err != nil {
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &typeErr) && typeErr.Field == "":
			return invalidRequest("the request body must be a JSON object")
		case errors.As(err, &typeErr):
			return invalidRequest("%q has the wrong type", typeErr.Field)
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			// encoding/json has no typed error for this one.
			return invalidRequest("%s", strings.TrimPrefix(err.Error(), "json: "))
		default:
			return invalidRequest("the request body is not valid JSON")
		}
	}
	if _, err := dec.Token(); err != io.EOF {
		return invalidRequest("the request body must be one JSON value")
	}

	// encoding/json matches keys case-insensitively and ignores absent ones; the contract does neither.
	var present map[string]json.RawMessage
	if err := json.Unmarshal(data, &present); err != nil {
		return invalidRequest("the request body must be a JSON object")
	}
	known := make(map[string]bool, len(fields))
	for _, f := range fields {
		known[f.name] = true
	}
	for key := range present {
		if !known[key] {
			return invalidRequest("unknown field %q", key)
		}
	}
	for _, f := range fields {
		if _, ok := present[f.name]; f.required && !ok {
			return invalidRequest("%q is required", f.name)
		}
	}
	return nil
}

// checkEnums rejects a string outside its field's enum:"a,b" list, at any depth. The empty string passes only when
// the field has omitempty. prefix is the JSON path of v.
func checkEnums(v reflect.Value, prefix string) error {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			return checkEnums(v.Elem(), prefix)
		}
	case reflect.Slice, reflect.Array:
		if !composite(v.Type().Elem()) {
			return nil
		}
		for i := 0; i < v.Len(); i++ {
			if err := checkEnums(v.Index(i), prefix); err != nil {
				return err
			}
		}
	case reflect.Map:
		if !composite(v.Type().Elem()) {
			return nil
		}
		for it := v.MapRange(); it.Next(); {
			if err := checkEnums(it.Value(), prefix); err != nil {
				return err
			}
		}
	case reflect.Struct:
		return checkStructEnums(v, prefix)
	}
	return nil
}

func checkStructEnums(v reflect.Value, prefix string) error {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		sf := t.Field(i)
		jsonTag := sf.Tag.Get("json")
		if !sf.IsExported() || jsonTag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(jsonTag, ",")
		if sf.Anonymous && name == "" {
			if err := checkEnums(v.Field(i), prefix); err != nil { // flattened into its parent
				return err
			}
			continue
		}
		if name == "" {
			name = sf.Name
		}
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		f := v.Field(i)
		list, ok := sf.Tag.Lookup("enum")
		if !ok {
			if err := checkEnums(f, path); err != nil {
				return err
			}
			continue
		}
		if f.Kind() == reflect.Pointer {
			if f.IsNil() {
				continue
			}
			f = f.Elem()
		}
		if f.Kind() != reflect.String {
			panic(fmt.Sprintf("enum on %s, which is not a string", path))
		}
		allowed := strings.Split(list, ",")
		s := f.String()
		omit := slices.Contains(strings.Split(opts, ","), "omitempty")
		if (s == "" && !omit) || (s != "" && !slices.Contains(allowed, s)) {
			return invalidRequest("%q must be one of %s", path, strings.Join(allowed, ", "))
		}
	}
	return nil
}

// composite reports whether values of t can hold struct fields.
func composite(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Struct, reflect.Pointer, reflect.Interface, reflect.Slice, reflect.Array, reflect.Map:
		return true
	}
	return false
}
