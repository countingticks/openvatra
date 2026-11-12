package api

import (
	"encoding/json"
	"errors"
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

// Config is what the config routes need; *config.Store implements it.
type Config interface {
	All() map[string]config.Entry
	Section(name string) (config.Entry, error)
	Put(name string, rev int, value json.RawMessage) (config.Entry, error)
	Subscribe(fn func(section string, rev int)) (cancel func())
}

// registerConfig adds the three config routes; without a store (tests only) they answer 503.
func registerConfig(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc("GET /api/config", getAllConfig(cfg))
	mux.HandleFunc("GET /api/config/{section}", getConfigSection(cfg))
	mux.HandleFunc("PUT /api/config/{section}", putConfigSection(cfg))
}

func writeUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusServiceUnavailable, "config_unavailable", "config storage is not available")
}

func getAllConfig(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if cfg == nil {
			writeUnavailable(w)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sections": cfg.All()})
	}
}

func getConfigSection(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg == nil {
			writeUnavailable(w)
			return
		}
		name := r.PathValue("section")
		entry, err := cfg.Section(name)
		if err != nil {
			writeConfigError(w, cfg, name, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	}
}

func putConfigSection(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg == nil {
			writeUnavailable(w)
			return
		}
		name := r.PathValue("section")
		var body struct {
			Rev   *int            `json:"rev"`
			Value json.RawMessage `json:"value"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil || body.Rev == nil || *body.Rev < 0 || len(body.Value) == 0 {
			writeError(w, http.StatusBadRequest, "invalid_config", `the body must be {"rev": n, "value": {…}}`)
			return
		}
		entry, err := cfg.Put(name, *body.Rev, body.Value)
		if err != nil {
			writeConfigError(w, cfg, name, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	}
}

// writeConfigError maps the store's errors to statuses; the cause of an unexpected one is logged by the store.
func writeConfigError(w http.ResponseWriter, cfg Config, name string, err error) {
	var invalid *config.InvalidError
	switch {
	case errors.As(err, &invalid):
		writeError(w, http.StatusBadRequest, "invalid_config", invalid.Message)
	case errors.Is(err, config.ErrUnknownSection):
		writeError(w, http.StatusNotFound, "unknown_section", `no config section "`+name+`"`)
	case errors.Is(err, config.ErrConflict):
		current, _ := cfg.Section(name)
		writeConflict(w, "the section changed since it was read", current)
	case errors.Is(err, config.ErrUnavailable):
		writeUnavailable(w)
	default:
		writeError(w, http.StatusInternalServerError, "config_failed", "could not save the config")
	}
}
