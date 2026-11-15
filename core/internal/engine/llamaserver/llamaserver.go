// Package llamaserver is the engine that runs GGUF models with llama.cpp's llama-server. It only builds the
// command line; engine.Runner starts, health-checks and stops the process.
package llamaserver

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/logs"
	"github.com/countingticks/openvatra/core/internal/seam"
)

const ID = "engine.llamaserver"

var (
	_ engine.Engine = (*Engine)(nil)
	_ seam.Checker  = (*Engine)(nil)
)

type Engine struct {
	path   func() string // read on every call: a Settings change applies to the next load
	logOut io.Writer
	runner engine.Runner
}

func New(path func() string, logOut io.Writer) *Engine {
	return &Engine{path: path, logOut: logOut}
}

func (e *Engine) Describe() seam.Descriptor {
	return seam.Descriptor{ID: ID, Title: "llama-server", Description: "Runs GGUF models with llama.cpp's server."}
}

// Command is llama-server's command line for spec: core's own flags first, then the user's. Placement and Shape
// are ignored until slice 4.
func (e *Engine) Command(spec engine.Spec) engine.Command {
	args := []string{"-m", spec.Path, "--host", "127.0.0.1"}
	if spec.Embedding {
		args = append(args, "--embeddings")
	} else if spec.Context > 0 {
		args = append(args, "-c", strconv.Itoa(spec.Context))
	}
	// Embedding servers never take images, so a projector would only cost memory there.
	if spec.Projector != "" && !spec.Embedding {
		args = append(args, "--mmproj", spec.Projector)
	}
	return engine.Command{
		Path:     e.path(),
		Args:     append(args, spec.Args...),
		PortFlag: "--port",
		Health:   "/health",
	}
}

// Start's load timeout is the caller's ctx; every output line goes to logOut prefixed with the model id.
func (e *Engine) Start(ctx context.Context, spec engine.Spec) (engine.Instance, error) {
	out := e.logOut
	if out == nil {
		out = io.Discard
	}
	return e.runner.Start(ctx, e.Command(spec), logs.Prefixed(out, spec.Model))
}

// computeAllowance is what llama-server's compute buffers take on top of weights and KV cache.
const computeAllowance int64 = 512 << 20

// Needs estimates the memory spec takes: the weights and projector, an f16 KV cache for the context size and a
// fixed compute allowance, split by the placement. Unknown (zero Resources) when the shape or context is missing.
// The KV size overestimates hybrid and sliding-window models; measurements correct it later.
func (e *Engine) Needs(spec engine.Spec) engine.Resources {
	s := spec.Shape
	if spec.Embedding || spec.Context <= 0 || s.FileBytes == 0 || s.Layers == 0 || s.KVHeads == 0 ||
		s.KeyLen == 0 || s.ValueLen == 0 || s.MaxContext == 0 {
		return engine.Resources{}
	}
	kv := int64(spec.Context) * int64(s.Layers) * int64(s.KVHeads) * int64(s.KeyLen+s.ValueLen) * 2
	fixed := s.ProjectorBytes + kv + computeAllowance
	r := engine.Resources{Known: true, Source: "estimate"}
	switch spec.Placement.Kind {
	case engine.PlaceExperts:
		r.VRAMBytes, r.RAMBytes = s.FileBytes-s.ExpertBytes+fixed, s.ExpertBytes
	case engine.PlaceLayers:
		n := int64(min(max(spec.Placement.Layers, 0), s.Layers))
		onGPU := s.FileBytes * n / int64(s.Layers)
		r.VRAMBytes, r.RAMBytes = onGPU+fixed, s.FileBytes-onGPU
	case engine.PlaceCPU:
		r.RAMBytes = s.FileBytes + fixed
	default:
		r.VRAMBytes = s.FileBytes + fixed
	}
	return r
}

func (e *Engine) Check(context.Context) seam.Health {
	p := e.path()
	if p == "" {
		return seam.Health{Reason: "No llama-server.exe found."}
	}
	if fi, err := os.Stat(p); err != nil || !fi.Mode().IsRegular() {
		return seam.Health{Reason: fmt.Sprintf("No llama-server.exe found at %s.", p)}
	}
	return seam.Health{OK: true}
}
