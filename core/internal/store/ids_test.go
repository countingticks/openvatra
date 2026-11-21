package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

var ctx = context.Background()

// newStore returns a store whose time moves forward 1 s per call, so ordering is deterministic.
func newStore(t *testing.T) *Store {
	t.Helper()
	s, _ := newEventStore(t)
	return s
}

// newEventStore is newStore together with the bus its events are published on.
func newEventStore(t *testing.T) (*Store, *event.Bus) {
	t.Helper()
	bus := event.NewBus(64)
	s, err := Open(t.TempDir(), bus)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	base := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	n := 0
	s.now = func() time.Time { n++; return base.Add(time.Duration(n) * time.Second) }
	return s, bus
}

// must unwraps a (value, error) pair: Go allows f(g()) only when f takes exactly g's results, so no t parameter here.
// A panic fails the test with the stack, which is fine for setup steps.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func TestNewIDIsUUIDv4AndUnique(t *testing.T) {
	a, b := NewID(), NewID()
	if a == b || len(a) != 36 || a[14] != '4' || !strings.ContainsRune("89ab", rune(a[19])) {
		t.Fatalf("bad ids: %s %s", a, b)
	}
}

func TestCutTitle(t *testing.T) {
	long := "Please explain how the Rust borrow checker decides when a reference is still alive in a loop"
	cases := map[string]string{
		"  hello \n  world ":    "hello world",
		long:                    "Please explain how the Rust borrow checker…",
		strings.Repeat("a", 80): strings.Repeat("a", 50) + "…",
		"":                      "",
	}
	for in, want := range cases {
		if got := CutTitle(in); got != want {
			t.Errorf("CutTitle(%q) = %q, want %q", in, got, want)
		}
	}
}
