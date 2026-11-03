package api

import (
	"encoding/json"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/config"
)

// configHandler replaces the whole config. Main sends a full snapshot each time, so a partial update can't leave
// core half-configured; unknown fields are an error so a typo in main shows up instead of being ignored.
func configHandler(store *config.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var c config.Config
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_config", "the config is not valid JSON of the expected shape")
			return
		}
		if err := store.Set(c); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_config", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
