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

// Needs is unknown until slice 4.
func (e *Engine) Needs(engine.Spec) engine.Resources { return engine.Resources{} }

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
