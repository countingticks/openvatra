// Package openapi builds an OpenAPI 3.1 document from Go types. Standard library only; imported only by api.
package openapi

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"
)

// Schema is the subset of JSON Schema the contract uses.
type Schema struct {
	Ref                  string             `json:"$ref,omitempty"`
	Type                 any                `json:"type,omitempty"` // "string", or []string{"string", "null"}
	Format               string             `json:"format,omitempty"`
	Description          string             `json:"description,omitempty"`
	Enum                 []string           `json:"enum,omitempty"`
	Properties           map[string]*Schema `json:"properties,omitempty"`
	Required             []string           `json:"required,omitempty"` // in field order
	AdditionalProperties *Schema            `json:"additionalProperties,omitempty"`
	Items                *Schema            `json:"items,omitempty"`
	OneOf                []*Schema          `json:"oneOf,omitempty"`
}

// Reflector turns Go types into schemas and remembers the named structs as components.
type Reflector struct {
	components map[string]*Schema
	owners     map[string]reflect.Type
}

var (
	timeType = reflect.TypeOf(time.Time{})
	rawType  = reflect.TypeOf(json.RawMessage(nil))
)

func NewReflector() *Reflector {
	return &Reflector{components: map[string]*Schema{}, owners: map[string]reflect.Type{}}
}

// Schema returns the schema of t. A named struct becomes a component and the result is {"$ref":
// "#/components/schemas/<Name>"}; every other type is inline.
func (r *Reflector) Schema(t reflect.Type) *Schema {
	switch {
	case t == timeType:
		return &Schema{Type: "string", Format: "date-time"}
	case t == rawType:
		return &Schema{}
	}
	switch t.Kind() {
	case reflect.String:
		return &Schema{Type: "string"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return &Schema{Type: "integer"}
	case reflect.Float32, reflect.Float64:
		return &Schema{Type: "number"}
	case reflect.Bool:
		return &Schema{Type: "boolean"}
	case reflect.Slice, reflect.Array:
		return &Schema{Type: "array", Items: r.Schema(t.Elem())}
	case reflect.Map:
		if t.Key().Kind() != reflect.String {
			panic(fmt.Sprintf("openapi: map key of %s must be a string", t))
		}
		return &Schema{Type: "object", AdditionalProperties: r.Schema(t.Elem())}
	case reflect.Interface:
		if t.NumMethod() != 0 {
			panic(fmt.Sprintf("openapi: unsupported type %s", t))
		}
		return &Schema{}
	case reflect.Ptr:
		if t.Elem().Kind() == reflect.Ptr {
			panic(fmt.Sprintf("openapi: pointer to pointer %s", t))
		}
		inner := r.Schema(t.Elem())
		switch {
		case inner.Ref != "":
			return &Schema{OneOf: []*Schema{inner, {Type: "null"}}}
		case inner.Type == nil:
			return inner
		}
		inner.Type = []string{inner.Type.(string), "null"}
		return inner
	case reflect.Struct:
		if t.Name() == "" {
			return r.structSchema(t)
		}
		return r.component(t)
	}
	panic(fmt.Sprintf("openapi: unsupported type %s", t))
}

// Define adds a hand-built component and returns its $ref. Panics when name is taken.
func (r *Reflector) Define(name string, s *Schema) *Schema {
	if _, ok := r.components[name]; ok {
		panic(fmt.Sprintf("openapi: component %s already defined", name))
	}
	r.components[name] = s
	return &Schema{Ref: "#/components/schemas/" + name}
}

// Components returns every component added so far, by name.
func (r *Reflector) Components() map[string]*Schema {
	out := make(map[string]*Schema, len(r.components))
	for k, v := range r.components {
		out[k] = v
	}
	return out
}

func (r *Reflector) component(t reflect.Type) *Schema {
	name := t.Name()
	if strings.Contains(name, "[") {
		panic(fmt.Sprintf("openapi: generic type %s cannot be a component", t))
	}
	ref := &Schema{Ref: "#/components/schemas/" + name}
	if prev, ok := r.owners[name]; ok {
		if prev != t {
			panic(fmt.Sprintf("openapi: two types named %s: %s.%s and %s.%s", name, prev.PkgPath(), name, t.PkgPath(), name))
		}
		return ref
	}
	if _, ok := r.components[name]; ok {
		panic(fmt.Sprintf("openapi: component %s already defined", name))
	}
	// Registered before the fields are walked so recursive types terminate.
	r.owners[name] = t
	placeholder := &Schema{}
	r.components[name] = placeholder
	*placeholder = *r.structSchema(t)
	return ref
}

type field struct {
	name     string
	schema   *Schema
	required bool
	depth    int
	tagged   bool
}

// structSchema is the inline object schema of a struct: path and query fields are left out.
func (r *Reflector) structSchema(t reflect.Type) *Schema {
	var all []field
	r.collect(t, 0, &all)

	best := map[string]int{} // name -> index of the winning field in all
	for i, f := range all {
		j, seen := best[f.name]
		switch {
		case !seen:
			best[f.name] = i
		case f.depth < all[j].depth:
			best[f.name] = i
		case f.depth == all[j].depth:
			if f.tagged == all[j].tagged {
				panic(fmt.Sprintf("openapi: %s has two fields named %s at the same depth", t, f.name))
			}
			if f.tagged {
				best[f.name] = i
			}
		}
	}

	s := &Schema{Type: "object", Properties: map[string]*Schema{}}
	for i, f := range all {
		if best[f.name] != i {
			continue
		}
		s.Properties[f.name] = f.schema
		if f.required {
			s.Required = append(s.Required, f.name)
		}
	}
	return s
}

func (r *Reflector) collect(t reflect.Type, depth int, out *[]field) {
	for i := 0; i < t.NumField(); i++ {
		sf := t.Field(i)
		jsonTag, hasJSON := sf.Tag.Lookup("json")
		if jsonTag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(jsonTag, ",")
		if sf.Anonymous && name == "" {
			ft := sf.Type
			if ft.Kind() == reflect.Ptr {
				panic(fmt.Sprintf("openapi: embedded pointer %s in %s", ft, t))
			}
			if ft.Kind() == reflect.Struct && ft != timeType {
				r.collect(ft, depth+1, out)
				continue
			}
		}
		if !sf.IsExported() {
			continue
		}
		if _, ok := sf.Tag.Lookup("path"); ok {
			continue
		}
		if _, ok := sf.Tag.Lookup("query"); ok {
			continue
		}
		tagged := hasJSON && name != ""
		if name == "" {
			name = sf.Name
		}
		s := r.Schema(sf.Type)
		if doc := sf.Tag.Get("doc"); doc != "" {
			s.Description = doc
		}
		if enum, ok := sf.Tag.Lookup("enum"); ok {
			ft := sf.Type
			if ft.Kind() == reflect.Ptr {
				ft = ft.Elem()
			}
			if ft.Kind() != reflect.String {
				panic(fmt.Sprintf("openapi: enum on non-string field %s.%s", t, sf.Name))
			}
			s.Enum = strings.Split(enum, ",")
		}
		omit := false
		for _, o := range strings.Split(opts, ",") {
			if o == "omitempty" {
				omit = true
			}
		}
		*out = append(*out, field{name: name, schema: s, required: !omit, depth: depth, tagged: tagged})
	}
}
