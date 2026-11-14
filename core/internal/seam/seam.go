// Package seam holds what every seam of core shares: the descriptor an implementation gives of itself, its
// health, the optional lifecycle interfaces and the registry that indexes implementations by id.
package seam

import (
	"context"
	"encoding/json"
	"fmt"
)

// Descriptor says what an implementation is.
type Descriptor struct {
	ID          string          `json:"id"` // lowercase, dot-separated: "engine.llamaserver"
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Settings    json.RawMessage `json:"settings,omitempty"` // JSON Schema of its config section; nil until slice 3
}

// Health is the answer of a Checker.
type Health struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"` // one sentence for the UI when not OK
}

type Described interface{ Describe() Descriptor }

type Configurable interface {
	Configure(section json.RawMessage) error
}
type Starter interface {
	Start(ctx context.Context) error
}
type Stopper interface {
	Stop(ctx context.Context) error
}
type Checker interface {
	Check(ctx context.Context) Health
}

// Registry keeps implementations in registration order, indexed by id. It is written only at startup, so it
// takes no lock.
type Registry[T Described] struct {
	list []T
	byID map[string]T
}

func NewRegistry[T Described]() *Registry[T] {
	return &Registry[T]{byID: map[string]T{}}
}

// Register panics on an empty or duplicate id: both are programming errors found at startup.
func (r *Registry[T]) Register(x T) {
	id := x.Describe().ID
	if id == "" {
		panic("seam: empty id")
	}
	if _, dup := r.byID[id]; dup {
		panic(fmt.Sprintf("seam: duplicate id %q", id))
	}
	r.byID[id] = x
	r.list = append(r.list, x)
}

func (r *Registry[T]) Get(id string) (T, bool) {
	x, ok := r.byID[id]
	return x, ok
}

// All returns a new slice each call.
func (r *Registry[T]) All() []T {
	return append([]T(nil), r.list...)
}
