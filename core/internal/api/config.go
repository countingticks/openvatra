package api

import (
	"encoding/json"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/config"
)

// postedConfig is the body main sends today: a full snapshot with resolved paths and split argument lists.
type postedConfig struct {
	LlamaServerPath   string                   `json:"llamaServerPath"`
	ModelsDir         string                   `json:"modelsDir"`
	EmbeddingModel    string                   `json:"embeddingModel"`
	IdleUnloadMinutes int                      `json:"idleUnloadMinutes"`
	Options           map[string]postedOptions `json:"options"`
}

type postedOptions struct {
	Args []string `json:"args"`
}

// configHandler replaces the in-memory override with main's snapshot. A full snapshot each time, so a partial update
// can't leave core half-configured; unknown fields are an error so a typo in main shows up instead of being ignored.
func configHandler(override *config.Override) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var c postedConfig
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_config", "the config is not valid JSON of the expected shape")
			return
		}
		if err := override.Set(c.models()); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_config", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// models converts the posted snapshot: "" and 0 mean "not chosen", argument lists go back to text. The engine never
// decides anything here, because main always sends a concrete llamaServerPath.
func (c postedConfig) models() config.Models {
	m := config.Models{
		LlamaServerPath: nonEmpty(c.LlamaServerPath),
		ModelsDir:       nonEmpty(c.ModelsDir),
		EmbeddingModel:  nonEmpty(c.EmbeddingModel),
		Options:         make(map[string]config.ModelOptions, len(c.Options)),
		Engine:          "bundled",
	}
	if c.IdleUnloadMinutes != 0 {
		minutes := c.IdleUnloadMinutes
		m.IdleUnloadMinutes = &minutes
	}
	for id, o := range c.Options {
		m.Options[id] = config.ModelOptions{Args: config.JoinArgs(o.Args)}
	}
	return m
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
