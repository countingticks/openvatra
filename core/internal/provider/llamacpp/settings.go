package llamacpp

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
)

// ID is the provider's descriptor id and the name of its config section.
const ID = "provider.llamacpp"

// LlamaCppSettings is the provider.llamacpp config section: where the models are and how they run. A nil pointer
// means "not chosen": core then uses its own default (see Resolve).
type LlamaCppSettings struct {
	ModelsDir *string `json:"modelsDir"` // nil = %USERPROFILE%\OpenVatra\Models
	// EmbeddingModel is a model id; nil means Automatic. Only an embedding model counts (see models.ResolveEmbedding).
	EmbeddingModel    *string                 `json:"embeddingModel"`
	IdleUnloadMinutes *int                    `json:"idleUnloadMinutes"` // nil = never
	Options           map[string]ModelOptions `json:"options"`
}

// ModelOptions are one model's own settings.
type ModelOptions struct {
	// Args is the argument text as the user typed it. Core splits it into a list (config.SplitArgs) and hands that
	// straight to the process, never to a shell. "--no-mmproj" in it stops core from adding the detected projector.
	// Flags core decides itself (config.ReservedFlags) are refused, so the user can't override them through
	// arguments. An option with no arguments is written as {}, which is what the UI sends.
	Args string `json:"args,omitempty"`
	// Context is the size in tokens the model loads with; nil (or null) = auto, chosen by fit for the hardware.
	Context *int `json:"context,omitempty"`
	// Placement is where the weights go; "" = auto, chosen with the context size.
	Placement string `json:"placement,omitempty" enum:"auto,gpu,experts,layers,cpu"`
}

// The context sizes a user may set.
const (
	MinContext = 2048
	MaxContext = 1048576
)

var placements = []string{"", "auto", "gpu", "experts", "layers", "cpu"}

// LlamaCppEffective is the section's read-only view: the models folder core really uses when none is chosen.
type LlamaCppEffective struct {
	ModelsDir string `json:"modelsDir"`
}

// DefaultSettings are the values before anything was chosen; the same as settings.json v6's defaults.
func DefaultSettings() LlamaCppSettings {
	minutes := 15
	return LlamaCppSettings{IdleUnloadMinutes: &minutes, Options: map[string]ModelOptions{}}
}

// ShellOnly lists the models folder: only main sets it (the user picks it in a file dialog); a ui token may only
// reset it to null.
func (LlamaCppSettings) ShellOnly() []string { return []string{"modelsDir"} }

// Validate rejects values core must not act on. The first failure wins; each message is one sentence naming the
// field.
func (s LlamaCppSettings) Validate() error {
	if err := config.ValidatePath("modelsDir", s.ModelsDir); err != nil {
		return err
	}
	if s.EmbeddingModel != nil && *s.EmbeddingModel == "" {
		return errors.New("embeddingModel must not be empty")
	}
	if n := s.IdleUnloadMinutes; n != nil && (*n < 1 || *n > 1440) {
		return errors.New("idleUnloadMinutes must be between 1 and 1440")
	}
	if s.Options == nil {
		return errors.New("options must be an object")
	}
	ids := make([]string, 0, len(s.Options))
	for id := range s.Options {
		ids = append(ids, id)
	}
	slices.Sort(ids) // so the same value always reports the same failure
	for _, id := range ids {
		if id == "" {
			return errors.New("options has an empty model id")
		}
	}
	for _, id := range ids {
		text := s.Options[id].Args
		if strings.ContainsRune(text, 0) {
			return fmt.Errorf("options for %q: args must not contain a NUL character", id)
		}
		if _, err := config.SplitArgs(text); err != nil {
			return fmt.Errorf("options for %q: %s", id, err.Error())
		}
	}
	for _, id := range ids {
		o := s.Options[id]
		if o.Context != nil && (*o.Context < MinContext || *o.Context > MaxContext) {
			return fmt.Errorf("options for %q: context must be between %d and %d", id, MinContext, MaxContext)
		}
		if !slices.Contains(placements, o.Placement) {
			return fmt.Errorf("options for %q: placement must be auto, gpu, experts, layers or cpu", id)
		}
	}
	return nil
}

// Resolved are the values core acts on: every default filled in, every argument text split.
type Resolved struct {
	ModelsDir, EmbeddingModel string
	IdleUnloadMinutes         int // 0 = never
	args                      map[string][]string
	sizes                     map[string]size
}

type size struct {
	context   int
	placement string
}

// Resolve fills in the defaults; home is os.UserHomeDir(), "" = no default models folder.
func (s LlamaCppSettings) Resolve(home string) Resolved {
	r := Resolved{args: make(map[string][]string, len(s.Options)), sizes: make(map[string]size, len(s.Options))}
	switch {
	case s.ModelsDir != nil:
		r.ModelsDir = *s.ModelsDir
	case home != "":
		r.ModelsDir = filepath.Join(home, "OpenVatra", "Models")
	}
	if s.EmbeddingModel != nil {
		r.EmbeddingModel = *s.EmbeddingModel
	}
	if s.IdleUnloadMinutes != nil {
		r.IdleUnloadMinutes = *s.IdleUnloadMinutes
	}
	for id, o := range s.Options {
		// Text that does not split only gets here by skipping Validate; such a model runs with no arguments.
		if args, err := config.SplitArgs(o.Args); err == nil && len(args) > 0 {
			r.args[id] = args
		}
		var z size
		if o.Context != nil {
			z.context = *o.Context
		}
		if o.Placement != "auto" {
			z.placement = o.Placement
		}
		if z != (size{}) {
			r.sizes[id] = z
		}
	}
	return r
}

// Effective turns the section into its read-only view.
func Effective(home string) func(LlamaCppSettings) LlamaCppEffective {
	return func(s LlamaCppSettings) LlamaCppEffective {
		return LlamaCppEffective{ModelsDir: s.Resolve(home).ModelsDir}
	}
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

// Size is model id's context size (0 = auto) and placement ("auto" unless the user chose one).
func (r Resolved) Size(id string) (context int, placement string) {
	z := r.sizes[id]
	if z.placement == "" {
		z.placement = "auto"
	}
	return z.context, z.placement
}

// UseMMProj reports whether model id gets its vision projector (when one was found): always, unless its own
// arguments contain --no-mmproj, which llama-server itself also understands.
func (r Resolved) UseMMProj(id string) bool {
	return !slices.Contains(r.args[id], "--no-mmproj")
}
