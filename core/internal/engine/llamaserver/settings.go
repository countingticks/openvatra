package llamaserver

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/countingticks/openvatra/core/internal/config"
)

// LlamaServerSettings is the engine.llamaserver config section: which llama-server core starts.
type LlamaServerSettings struct {
	Path  *string `json:"path"` // nil = the bundled build, or the CUDA build when chosen and present
	Build string  `json:"build" enum:"bundled,cuda"`
}

// LlamaServerEffective is the section's read-only view: the llama-server core really starts.
type LlamaServerEffective struct {
	Path string `json:"path"`
}

// DefaultSettings are the values before anything was chosen.
func DefaultSettings() LlamaServerSettings { return LlamaServerSettings{Build: "bundled"} }

// ShellOnly lists the path: a program path the page could set would be a program core starts, so only main sets it
// (the user picks it in a file dialog); a ui token may only reset it to null.
func (LlamaServerSettings) ShellOnly() []string { return []string{"path"} }

// Validate rejects values core must not act on; each message is one sentence naming the field.
func (s LlamaServerSettings) Validate() error {
	if err := config.ValidatePath("path", s.Path); err != nil {
		return err
	}
	if s.Build != "bundled" && s.Build != "cuda" {
		return errors.New(`build must be "bundled" or "cuda"`)
	}
	return nil
}

// Env is what Resolve needs from outside the section: where the engines are.
type Env struct {
	LlamaDir   string // --llama-dir; "" = no bundled engine known
	EnginesDir string // --engines-dir
	Tag        string // pinned llama.cpp tag (downloads.Engine.Tag); "" = no CUDA build
}

// Resolve is the llama-server path core uses, "" when none is known. The rule is the one bundledLlama.ts used: the
// chosen path, else the CUDA build when it was chosen and is on disk for the pinned tag, else the bundled one.
func (s LlamaServerSettings) Resolve(env Env) string {
	cuda := filepath.Join(env.EnginesDir, env.Tag+"-cuda", "llama-server.exe")
	switch {
	case s.Path != nil:
		return *s.Path
	case s.Build == "cuda" && env.Tag != "" && isFile(cuda):
		return cuda
	case env.LlamaDir != "":
		return filepath.Join(env.LlamaDir, "llama-server.exe")
	}
	return ""
}

// Effective turns the section into its read-only view.
func Effective(env Env) func(LlamaServerSettings) LlamaServerEffective {
	return func(s LlamaServerSettings) LlamaServerEffective { return LlamaServerEffective{Path: s.Resolve(env)} }
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
