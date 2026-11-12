package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/config"
)

// Config is what the config routes need; *config.Store implements it.
type Config interface {
	All() map[string]config.SectionEntry
	Section(name string) (config.SectionEntry, error)
	Put(name string, rev int, value json.RawMessage) (config.SectionEntry, error)
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
