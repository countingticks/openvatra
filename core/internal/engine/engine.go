// Package engine is the seam for programs that serve one model: an Engine turns a Spec into a running Instance.
// Runner is the shared way to run such a program; implementations (engine/llamaserver) only build its command line.
package engine

import (
	"context"
	"time"

	"github.com/countingticks/openvatra/core/internal/seam"
)

// Engine starts model servers of one kind.
type Engine interface {
	seam.Described
	Start(ctx context.Context, spec Spec) (Instance, error) // returns once healthy; ctx bounds the wait
	Needs(spec Spec) Resources
}

// Spec is what to start.
type Spec struct {
	Model     string // id, for logs and the log prefix
	Path      string // model file (first part of a split model)
	Projector string // "" = none
	Embedding bool
	Context   int       // tokens; 0 = the engine's own default
	Placement Placement // zero value = PlaceGPU; ignored until slice 4
	Args      []string  // the user's own, after core's
	Shape     Shape     // zero until slice 4
}

type PlaceKind int

const (
	PlaceGPU PlaceKind = iota
	PlaceExperts
	PlaceLayers
	PlaceCPU
)

type Placement struct {
	Kind   PlaceKind
	Layers int // PlaceLayers only: layers on the GPU; 0 = let the engine choose
}

type Shape struct {
	FileBytes, ProjectorBytes, ExpertBytes int64
	Layers, KVHeads, KeyLen, ValueLen      int
	MaxContext                             int
}

type Resources struct {
	VRAMBytes, RAMBytes int64
	Known               bool
	Source              string // "estimate" or "measured"; "" when !Known
}

type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateReady    State = "ready"
)

// Instance is one running server.
type Instance interface {
	BaseURL() string // "http://127.0.0.1:<port>"
	State() State
	Stop(grace time.Duration) // tree terminate, kill after grace; returns when gone
	Wait() <-chan struct{}    // closed when the process has exited
}
