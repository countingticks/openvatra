package seam

import (
	"strings"
	"testing"
)

type described struct{ id, tag string }

func (d described) Describe() Descriptor { return Descriptor{ID: d.id} }

func mustPanic(t *testing.T, want string, f func()) {
	t.Helper()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatalf("no panic, want %q", want)
		}
		if msg, _ := r.(string); !strings.Contains(msg, want) {
			t.Fatalf("panic %v, want %q", r, want)
		}
	}()
	f()
}

func TestGet(t *testing.T) {
	r := NewRegistry[described]()
	r.Register(described{id: "a.b", tag: "x"})
	if got, ok := r.Get("a.b"); !ok || got.tag != "x" {
		t.Fatalf("Get = %v, %v", got, ok)
	}
	if got, ok := r.Get("nope"); ok || got != (described{}) {
		t.Fatalf("Get unknown = %v, %v", got, ok)
	}
}

func TestAllKeepsOrderAndIsACopy(t *testing.T) {
	r := NewRegistry[described]()
	for _, id := range []string{"c.c", "a.a", "b.b"} {
		r.Register(described{id: id})
	}
	all := r.All()
	if len(all) != 3 || all[0].id != "c.c" || all[1].id != "a.a" || all[2].id != "b.b" {
		t.Fatalf("All = %v", all)
	}
	all[0] = described{id: "zzz"}
	if r.All()[0].id != "c.c" {
		t.Fatal("writing into the returned slice changed the registry")
	}
}

func TestRegisterEmptyID(t *testing.T) {
	r := NewRegistry[described]()
	mustPanic(t, "seam: empty id", func() { r.Register(described{}) })
	if len(r.All()) != 0 {
		t.Fatal("registry changed")
	}
}

func TestRegisterDuplicateID(t *testing.T) {
	r := NewRegistry[described]()
	r.Register(described{id: "a.b", tag: "first"})
	mustPanic(t, `seam: duplicate id "a.b"`, func() { r.Register(described{id: "a.b", tag: "second"}) })
	if got, _ := r.Get("a.b"); got.tag != "first" || len(r.All()) != 1 {
		t.Fatalf("registry changed: %v", got)
	}
}
