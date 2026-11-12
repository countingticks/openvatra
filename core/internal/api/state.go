package api

import (
	"encoding/json"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/feed"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

func stateHandler(rt Router, list func() ([]models.Model, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		body, err := feed.State(rt, list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "models_unreadable", "could not read the models folder")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}
}

// loadHandler loads a model and answers once it is ready.
func loadHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := rt.Load(r.Context(), r.PathValue("id")); err != nil {
			writeAcquireError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": router.StateReady})
	}
}

// unloadHandler asks for a model to be unloaded. 202 because the server may
// still be finishing a reply and stops in the background.
// refreshHandler tells every listener to re-read the models folder. For changes core can't see itself: main moves a
// removed model to the Recycle Bin, and the list has to drop it.
func refreshHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		rt.Notify()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "refreshing"})
	}
}

func unloadHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rt.Unload(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "model_not_loaded", "that model is not loaded")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": feed.StateStopped})
	}
}
