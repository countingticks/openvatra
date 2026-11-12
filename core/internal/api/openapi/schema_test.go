package openapi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/api/openapi/internal/clash"
)

type kind string

type basics struct {
	S string
	I int
	U uint8
	F float32
	B bool
	K kind
}

type tags struct {
	Hidden     string `json:"-"`
	Optional   string `json:"optional,omitempty"`
	Ptr        *int   `json:"ptr"`
	Untagged   string
	unexport   string
	ID         string `path:"id"`
	Q          string `query:"q"`
	Documented string `json:"documented" doc:"what it is"`
	Mode       string `json:"mode" enum:"a,b,c"`
	KMode      kind   `json:"kmode" enum:"x,y"`
}

type inner struct {
	Shared string `json:"shared"`
	Inner  int    `json:"inner"`
}

type embedding struct {
	inner
	Shared int `json:"shared"`
	Own    string
}

type Leaf struct{ N int }

type twice struct {
	A Leaf
	B Leaf
	C *Leaf
}

type tree struct {
	Name     string  `json:"name"`
	Children []*tree `json:"children"`
}

type Item struct{ B int }

type generic[T any] struct{ V T }

type embeddedPtr struct{ *inner }

type badEnum struct {
	N int `enum:"a,b"`
}

type dupA struct{ X int }
type dupB struct{ X int }
type dupBoth struct {
	dupA
	dupB
}

func marshal(t *testing.T, s *Schema) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReflectorSchema(t *testing.T) {
	cases := []struct {
		name string
		typ  reflect.Type
		want string
	}{
		{"string", reflect.TypeOf(""), `{"type":"string"}`},
		{"int", reflect.TypeOf(int64(0)), `{"type":"integer"}`},
		{"uint", reflect.TypeOf(uint16(0)), `{"type":"integer"}`},
		{"float", reflect.TypeOf(float64(0)), `{"type":"number"}`},
		{"bool", reflect.TypeOf(true), `{"type":"boolean"}`},
		{"named basic", reflect.TypeOf(kind("")), `{"type":"string"}`},
		{"slice", reflect.TypeOf([]string{}), `{"type":"array","items":{"type":"string"}}`},
		{"array", reflect.TypeOf([2]bool{}), `{"type":"array","items":{"type":"boolean"}}`},
		{"map", reflect.TypeOf(map[string]int{}), `{"type":"object","additionalProperties":{"type":"integer"}}`},
		{"pointer to int", reflect.TypeOf(new(int)), `{"type":["integer","null"]}`},
		{"pointer to named struct", reflect.TypeOf(&Leaf{}), `{"oneOf":[{"$ref":"#/components/schemas/Leaf"},{"type":"null"}]}`},
		{"raw message", reflect.TypeOf(json.RawMessage(nil)), `{}`},
		{"any", reflect.TypeOf((*any)(nil)).Elem(), `{}`},
		{"time", reflect.TypeOf(time.Time{}), `{"type":"string","format":"date-time"}`},
		{"unnamed struct", reflect.TypeOf(struct {
			A int `json:"a"`
		}{}), `{"type":"object","properties":{"a":{"type":"integer"}},"required":["a"]}`},
		{"basics", reflect.TypeOf(basics{}), `{"$ref":"#/components/schemas/basics"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := marshal(t, NewReflector().Schema(c.typ)); got != c.want {
				t.Errorf("got %s\nwant %s", got, c.want)
			}
		})
	}
}

func component(t *testing.T, v any) string {
	t.Helper()
	r := NewReflector()
	typ := reflect.TypeOf(v)
	r.Schema(typ)
	return marshal(t, r.Components()[typ.Name()])
}

func TestStructFields(t *testing.T) {
	got := component(t, tags{})
	want := `{"type":"object","properties":{` +
		`"Untagged":{"type":"string"},` +
		`"documented":{"type":"string","description":"what it is"},` +
		`"kmode":{"type":"string","enum":["x","y"]},` +
		`"mode":{"type":"string","enum":["a","b","c"]},` +
		`"optional":{"type":"string"},` +
		`"ptr":{"type":["integer","null"]}},` +
		`"required":["ptr","Untagged","documented","mode","kmode"]}`
	if got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

func TestBasicsComponent(t *testing.T) {
	want := `{"type":"object","properties":{"B":{"type":"boolean"},"F":{"type":"number"},"I":{"type":"integer"},` +
		`"K":{"type":"string"},"S":{"type":"string"},"U":{"type":"integer"}},"required":["S","I","U","F","B","K"]}`
	if got := component(t, basics{}); got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

func TestEmbeddedFlattenedAndShadowed(t *testing.T) {
	want := `{"type":"object","properties":{"Own":{"type":"string"},"inner":{"type":"integer"},"shared":{"type":"integer"}},` +
		`"required":["inner","shared","Own"]}`
	if got := component(t, embedding{}); got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

func TestNamedStructIsComponentOnce(t *testing.T) {
	r := NewReflector()
	r.Schema(reflect.TypeOf(twice{}))
	comps := r.Components()
	if len(comps) != 2 {
		t.Fatalf("components = %d, want 2 (twice, Leaf)", len(comps))
	}
	if got := marshal(t, comps["twice"].Properties["A"]); got != `{"$ref":"#/components/schemas/Leaf"}` {
		t.Errorf("A = %s", got)
	}
}

func TestRecursiveType(t *testing.T) {
	want := `{"type":"object","properties":{"children":{"type":"array","items":{"oneOf":[` +
		`{"$ref":"#/components/schemas/tree"},{"type":"null"}]}},"name":{"type":"string"}},"required":["name","children"]}`
	if got := component(t, tree{}); got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

func TestDefine(t *testing.T) {
	r := NewReflector()
	ref := r.Define("Custom", &Schema{Type: "string"})
	if ref.Ref != "#/components/schemas/Custom" {
		t.Errorf("ref = %s", ref.Ref)
	}
	if _, ok := r.Components()["Custom"]; !ok {
		t.Error("Custom missing from Components")
	}
}

func TestReflectorPanics(t *testing.T) {
	r := NewReflector()
	r.Define("Taken", &Schema{})
	cases := []struct {
		name string
		fn   func()
		want string
	}{
		{"chan", func() { NewReflector().Schema(reflect.TypeOf(make(chan int))) }, "chan int"},
		{"func", func() { NewReflector().Schema(reflect.TypeOf(func() {})) }, "func()"},
		{"map key", func() { NewReflector().Schema(reflect.TypeOf(map[int]string{})) }, "map[int]string"},
		{"enum on int", func() { NewReflector().Schema(reflect.TypeOf(badEnum{})) }, "enum"},
		{"pointer to pointer", func() { NewReflector().Schema(reflect.TypeOf(new(*int))) }, "**int"},
		{"embedded pointer", func() { NewReflector().Schema(reflect.TypeOf(embeddedPtr{})) }, "embedded pointer"},
		{"generic", func() { NewReflector().Schema(reflect.TypeOf(generic[int]{})) }, "generic"},
		{"define taken", func() { r.Define("Taken", &Schema{}) }, "Taken"},
		{"same name", func() {
			r := NewReflector()
			r.Schema(reflect.TypeOf(Item{}))
			r.Schema(reflect.TypeOf(clash.Item{}))
		}, "openapi/internal/clash"},
		{"same depth", func() { NewReflector().Schema(reflect.TypeOf(dupBoth{})) }, "same depth"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			defer func() {
				v := recover()
				if v == nil {
					t.Fatal("expected a panic")
				}
				if msg, _ := v.(string); !strings.Contains(msg, c.want) {
					t.Errorf("panic %q does not mention %q", msg, c.want)
				}
			}()
			c.fn()
		})
	}
}
