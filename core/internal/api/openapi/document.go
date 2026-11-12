package openapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
)

type Info struct {
	Title    string // "OpenVatra core"
	Version  string // core's version
	APILevel int    // written as info.x-api-level
}

type Operation struct {
	Method, Path string // Go mux pattern, e.g. "POST", "/api/models/{id}/load"
	OperationID  string
	Summary      string
	Tag          string
	Scope        string       // "none" | "ui" | "shell", written as x-scope
	In           reflect.Type // nil = no parameters and no body
	Out          reflect.Type // nil = no response schema
	OutSchema    *Schema      // when set, used instead of Out (the event stream)
	Status       int          // success status
	ContentType  string       // success content type; "" = "application/json"
	Errors       []string     // codes listed in the default response's description
}

type obj = map[string]any

// Build returns the document as JSON: two-space indent, object keys sorted, no HTML escaping, final newline.
// errorType is the schema of every default response (api's ErrorBody).
func Build(info Info, ops []Operation, r *Reflector, errorType reflect.Type) []byte {
	paths := obj{}
	for _, op := range ops {
		item, _ := paths[op.Path].(obj)
		if item == nil {
			item = obj{}
			paths[op.Path] = item
		}
		item[strings.ToLower(op.Method)] = operation(op, r, errorType)
	}
	doc := obj{
		"openapi":    "3.1.0",
		"info":       obj{"title": info.Title, "version": info.Version, "x-api-level": info.APILevel},
		"paths":      paths,
		"components": obj{"schemas": r.Components()},
	}
	return canonical(doc)
}

func operation(op Operation, r *Reflector, errorType reflect.Type) obj {
	o := obj{
		"operationId": op.OperationID,
		"summary":     op.Summary,
		"tags":        []string{op.Tag},
		"x-scope":     op.Scope,
	}
	if op.In != nil {
		params, body := inputs(op.In, r)
		if len(params) > 0 {
			o["parameters"] = params
		}
		if body != nil {
			o["requestBody"] = obj{"required": true, "content": obj{"application/json": obj{"schema": body}}}
		}
	}

	ct := op.ContentType
	if ct == "" {
		ct = "application/json"
	}
	ok := obj{"description": http.StatusText(op.Status)}
	switch {
	case op.OutSchema != nil:
		ok["content"] = obj{ct: obj{"schema": op.OutSchema}}
	case op.Out != nil:
		ok["content"] = obj{ct: obj{"schema": r.Schema(op.Out)}}
	case op.Status != http.StatusNoContent:
		ok["content"] = obj{ct: obj{}}
	}

	desc := "Error."
	if len(op.Errors) > 0 {
		desc = "Error. Codes: " + strings.Join(op.Errors, ", ") + "."
	}
	o["responses"] = obj{
		strconv.Itoa(op.Status): ok,
		"default": obj{
			"description": desc,
			"content":     obj{"application/json": obj{"schema": r.Schema(errorType)}},
		},
	}
	return o
}

// inputs splits a request struct into parameters (path, query) and the JSON body schema, nil when there is none.
func inputs(in reflect.Type, r *Reflector) ([]obj, *Schema) {
	var params []obj
	hasParam := false
	for i := 0; i < in.NumField(); i++ {
		sf := in.Field(i)
		if !sf.IsExported() {
			continue
		}
		loc, name := "", ""
		if v, ok := sf.Tag.Lookup("path"); ok {
			loc, name = "path", v
		} else if v, ok := sf.Tag.Lookup("query"); ok {
			loc, name = "query", v
		}
		if loc == "" {
			continue
		}
		hasParam = true
		s := r.Schema(sf.Type)
		if doc := sf.Tag.Get("doc"); doc != "" {
			s.Description = doc
		}
		p := obj{"name": name, "in": loc, "required": loc == "path", "schema": s}
		if loc == "query" && sf.Type.Kind() == reflect.Slice {
			p["style"], p["explode"] = "form", false
		}
		params = append(params, p)
	}

	inline := r.structSchema(in)
	if len(inline.Properties) == 0 {
		return params, nil
	}
	if !hasParam && in.Name() != "" {
		return params, r.Schema(in)
	}
	return params, inline
}

func canonical(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		panic(err)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(generic); err != nil {
		panic(err)
	}
	return buf.Bytes() // Encode ends with one newline
}
