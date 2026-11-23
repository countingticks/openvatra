// Package llamaserver is the engine that runs GGUF models with llama.cpp's llama-server. It only builds the
// command line; engine.Runner starts, health-checks and stops the process.
package llamaserver

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

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

// FitMarginMiB is the free VRAM llama.cpp's fit leaves on each GPU (decision 43 Q1).
const FitMarginMiB = 384

// Command is llama-server's command line for spec: core's own flags first, then the user's. llama.cpp keeps the last
// value of a repeated flag, so a model's own -ctk, -ub, -np or -fitt win over core's defaults.
func (e *Engine) Command(spec engine.Spec) engine.Command {
	args := []string{"-m", spec.Path, "--host", "127.0.0.1"}
	if spec.Embedding {
		// Embedding servers keep llama-server's own size and placement, and never take images (a projector would
		// only cost memory there).
		args = append(args, "--embeddings")
	} else {
		if spec.Context > 0 {
			args = append(args, "-c", strconv.Itoa(spec.Context))
		}
		args = append(args, placementArgs(spec.Placement)...)
		// Core chose the placement, so llama-server's own fitting is off, except for experts: there its fit is what
		// decides how many expert layers stay on the GPU. It aborts when -ngl is set, so experts passes none.
		// -lv 4 makes it print the buffer sizes core measures (measure.go).
		if spec.Placement.Kind == engine.PlaceExperts {
			args = append(args, "--fit", "on", "-fitt", strconv.Itoa(FitMarginMiB))
		} else {
			args = append(args, "--fit", "off")
		}
		args = append(args, "-lv", "4", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "-np", "1", "-ub", "1024")
		if spec.Projector != "" {
			args = append(args, "--mmproj", spec.Projector)
		}
	}
	return engine.Command{
		Path:     e.path(),
		Args:     append(args, spec.Args...),
		PortFlag: "--port",
		Health:   "/health",
	}
}

// placementArgs are llama-server's flags for where the weights go.
func placementArgs(p engine.Placement) []string {
	switch p.Kind {
	case engine.PlaceExperts:
		return nil
	case engine.PlaceLayers:
		return []string{"-ngl", strconv.Itoa(p.Layers)}
	case engine.PlaceCPU:
		return []string{"-ngl", "0"}
	default:
		return []string{"-ngl", "all"}
	}
}

// Start's load timeout is the caller's ctx; every output line goes to logOut prefixed with the model id.
func (e *Engine) Start(ctx context.Context, spec engine.Spec) (engine.Instance, error) {
	out := e.logOut
	if out == nil {
		out = io.Discard
	}
	if spec.Embedding {
		return e.runner.Start(ctx, e.Command(spec), logs.Prefixed(out, spec.Model))
	}
	m := &measurer{}
	inst, err := e.runner.Start(ctx, e.Command(spec), io.MultiWriter(m, logs.Prefixed(out, spec.Model)))
	if err != nil {
		return nil, err
	}
	return &measuredInstance{Instance: inst, m: m}, nil
}

// computeAllowance is what llama-server's compute buffers take on top of weights and KV cache.
const computeAllowance int64 = 512 << 20

// Needs estimates the memory spec takes: the weights and projector, a KV cache for the attention layers at the cache
// types in spec.Args (q8_0 by default) and a fixed compute allowance, split by the placement. Unknown (zero
// Resources) when the shape or context is missing. It leaves out recurrent state; measurements correct it later.
func (e *Engine) Needs(spec engine.Spec) engine.Resources {
	s := spec.Shape
	if spec.Embedding || spec.Context <= 0 || s.FileBytes == 0 || s.Layers == 0 || s.KVHeads == 0 ||
		s.KeyLen == 0 || s.ValueLen == 0 || s.MaxContext == 0 {
		return engine.Resources{}
	}
	attn := s.AttentionLayers
	if attn <= 0 {
		attn = s.Layers
	}
	kNum, vNum := cacheNum(argValue(spec.Args, "-ctk", "--cache-type-k")), cacheNum(argValue(spec.Args, "-ctv", "--cache-type-v"))
	kv := int64(spec.Context) * int64(attn) * int64(s.KVHeads) * (int64(s.KeyLen)*kNum + int64(s.ValueLen)*vNum) / 32
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

// cacheNum is a cache type's bytes per 32 values over 1 (f16 = 64); an unknown type counts as f16.
func cacheNum(t string) int64 {
	switch t {
	case "q8_0":
		return 34
	case "q4_0":
		return 18
	}
	return 64
}

// argValue is the value of the last occurrence of either flag, as "-f v" or "-f=v"; q8_0 (core's default) when
// absent. A flag at the end with no value is ignored.
func argValue(args []string, short, long string) string {
	v := "q8_0"
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == short || a == long:
			if i+1 < len(args) {
				v = args[i+1]
				i++
			}
		case strings.HasPrefix(a, short+"="):
			v = strings.TrimPrefix(a, short+"=")
		case strings.HasPrefix(a, long+"="):
			v = strings.TrimPrefix(a, long+"=")
		}
	}
	return v
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
