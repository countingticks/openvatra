package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// ModelsSection is the name of the section that holds the model settings.
const ModelsSection = "models"

// Models is everything about running chat and embedding models. A nil pointer means "not chosen": core then uses its
// own default (see Resolve).
type Models struct {
	LlamaServerPath *string `json:"llamaServerPath"` // nil = the default engine
	ModelsDir       *string `json:"modelsDir"`       // nil = %USERPROFILE%\OpenVatra\Models
	// EmbeddingModel is a model id; nil means Automatic. Only an embedding model counts (see models.ResolveEmbedding).
	EmbeddingModel    *string                 `json:"embeddingModel"`
	IdleUnloadMinutes *int                    `json:"idleUnloadMinutes"` // nil = never
	Options           map[string]ModelOptions `json:"options"`
	Engine            string                  `json:"engine" enum:"bundled,cuda"`
}

// ModelsEffective is the models section's read-only view: the paths core really uses when none is chosen.
type ModelsEffective struct {
	LlamaServerPath string `json:"llamaServerPath"`
	ModelsDir       string `json:"modelsDir"`
}

// ModelOptions are one model's own settings.
type ModelOptions struct {
	// Args is the argument text as the user typed it. Core splits it into a list (SplitArgs) and hands that straight
	// to the process, never to a shell. "--no-mmproj" in it stops core from adding the detected projector. Flags core
	// decides itself (ReservedFlags) are refused, so the user can't override them through arguments.
	// An option with no arguments is written as {}, which is what the UI sends.
	Args string `json:"args,omitempty"`
}

// ShellOnly lists the paths: a program path the page could set would be a program core starts, so only main sets
// them (the user picks them in a file dialog); a ui token may only reset them to null.
func (Models) ShellOnly() []string { return []string{"llamaServerPath", "modelsDir"} }

// DefaultModels are the values before anything was chosen; the same as settings.json v6's defaults.
func DefaultModels() Models {
	minutes := 15
	return Models{IdleUnloadMinutes: &minutes, Options: map[string]ModelOptions{}, Engine: "bundled"}
}

// Validate rejects values core must not act on. The first failure wins; each message is one sentence naming the
// field.
func (m Models) Validate() error {
	if err := validatePath("llamaServerPath", m.LlamaServerPath); err != nil {
		return err
	}
	if err := validatePath("modelsDir", m.ModelsDir); err != nil {
		return err
	}
	if m.EmbeddingModel != nil && *m.EmbeddingModel == "" {
		return errors.New("embeddingModel must not be empty")
	}
	if n := m.IdleUnloadMinutes; n != nil && (*n < 1 || *n > 1440) {
		return errors.New("idleUnloadMinutes must be between 1 and 1440")
	}
	if m.Options == nil {
		return errors.New("options must be an object")
	}
	ids := make([]string, 0, len(m.Options))
	for id := range m.Options {
		ids = append(ids, id)
	}
	slices.Sort(ids) // so the same value always reports the same failure
	for _, id := range ids {
		if id == "" {
			return errors.New("options has an empty model id")
		}
	}
	for _, id := range ids {
		text := m.Options[id].Args
		if strings.ContainsRune(text, 0) {
			return fmt.Errorf("options for %q: args must not contain a NUL character", id)
		}
		if _, err := SplitArgs(text); err != nil {
			return fmt.Errorf("options for %q: %s", id, err.Error())
		}
	}
	if m.Engine != "bundled" && m.Engine != "cuda" {
		return errors.New(`engine must be "bundled" or "cuda"`)
	}
	return nil
}

func validatePath(field string, p *string) error {
	if p != nil && (*p == "" || !filepath.IsAbs(*p) || strings.ContainsRune(*p, 0)) {
		return fmt.Errorf("%s must be an absolute path", field)
	}
	return nil
}

// Env is what Resolve needs from outside the section: where the engines and the user's home are.
type Env struct {
	LlamaDir   string // --llama-dir; "" = no bundled engine known
	EnginesDir string // --engines-dir
	Tag        string // pinned llama.cpp tag (downloads.Engine.Tag); "" = no CUDA build
	Home       string // os.UserHomeDir(); "" = no default models folder
}

// Resolved are the values core acts on: every default filled in, every argument text split.
type Resolved struct {
	LlamaServerPath, ModelsDir, EmbeddingModel string
	IdleUnloadMinutes                          int // 0 = never
	args                                       map[string][]string
}

// Resolve fills in the defaults. The engine rule is the one bundledLlama.ts used: the CUDA build when it was chosen
// and is on disk for the pinned tag, else the bundled one.
func (m Models) Resolve(env Env) Resolved {
	r := Resolved{args: make(map[string][]string, len(m.Options))}
	switch {
	case m.LlamaServerPath != nil:
		r.LlamaServerPath = *m.LlamaServerPath
	case m.Engine == "cuda" && env.Tag != "" && isFile(filepath.Join(env.EnginesDir, env.Tag+"-cuda", "llama-server.exe")):
		r.LlamaServerPath = filepath.Join(env.EnginesDir, env.Tag+"-cuda", "llama-server.exe")
	case env.LlamaDir != "":
		r.LlamaServerPath = filepath.Join(env.LlamaDir, "llama-server.exe")
	}
	switch {
	case m.ModelsDir != nil:
		r.ModelsDir = *m.ModelsDir
	case env.Home != "":
		r.ModelsDir = filepath.Join(env.Home, "OpenVatra", "Models")
	}
	if m.EmbeddingModel != nil {
		r.EmbeddingModel = *m.EmbeddingModel
	}
	if m.IdleUnloadMinutes != nil {
		r.IdleUnloadMinutes = *m.IdleUnloadMinutes
	}
	for id, o := range m.Options {
		// Text that does not split only gets here by skipping Validate; such a model runs with no arguments.
		if args, err := SplitArgs(o.Args); err == nil && len(args) > 0 {
			r.args[id] = args
		}
	}
	return r
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// IdleTimeout is how long a model may sit unused before core unloads it. Zero means never. (The serving embedding
// model never unloads: it is small, and every RAG question needs it first. core decides which one that is, because
// it takes the model's kind from the file, so main.go handles that case before asking here.)
func (r Resolved) IdleTimeout() time.Duration {
	return time.Duration(r.IdleUnloadMinutes) * time.Minute
}

// Args are the user's arguments for model id. A copy, so appending to it never writes into the config; nil when the
// model has none.
func (r Resolved) Args(id string) []string {
	return slices.Clone(r.args[id])
}

// UseMMProj reports whether model id gets its vision projector (when one was found): always, unless its own
// arguments contain --no-mmproj, which llama-server itself also understands.
func (r Resolved) UseMMProj(id string) bool {
	return !slices.Contains(r.args[id], "--no-mmproj")
}
