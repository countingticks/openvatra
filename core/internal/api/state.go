package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

const stateStopped = "stopped"

// modelState is what the router knows about a model plus facts from disk.
// The embedded struct's fields are flattened into the same JSON object.
type modelState struct {
	router.ModelState
	SizeBytes int64 `json:"sizeBytes"`
	// Projector is the detected vision projector's file name (never its path); left out when there is none.
	Projector string `json:"projector,omitempty"`
	// Kind is chat, embedding or unreadable, read from the GGUF header; Error says why a file is unreadable.
	Kind  models.Kind `json:"kind"`
	Error string      `json:"error,omitempty"`
}

// stateBody is the JSON of GET /api/state and of every "state" event.
type stateBody struct {
	Models []modelState `json:"models"`
}

// currentState lists every model on disk: what the router knows about it, or
// "stopped" when it has never been touched or has been unloaded.
func currentState(rt Router, list func() ([]models.Model, error)) (stateBody, error) {
	found, err := list()
	if err != nil {
		return stateBody{}, err
	}
	known := map[string]router.ModelState{}
	for _, m := range rt.Snapshot() {
		known[m.ID] = m
	}
	out := make([]modelState, 0, len(found)) // [] rather than null when empty
	for _, m := range found {
		st, ok := known[m.ID]
		if !ok {
			st = router.ModelState{ID: m.ID, State: stateStopped}
		}
		projector := ""
		if m.MMProj != "" {
			projector = filepath.Base(m.MMProj)
		}
		// Both the router and the header can have an error; the outer field shadows the embedded one in JSON, so merge.
		errText := st.Error
		if errText == "" {
			errText = m.Error
		}
		out = append(out, modelState{ModelState: st, SizeBytes: m.SizeBytes, Projector: projector, Kind: m.Kind, Error: errText})
	}
	return stateBody{Models: out}, nil
}

func stateHandler(rt Router, list func() ([]models.Model, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		body, err := currentState(rt, list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "models_unreadable", "could not read the models folder")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}
}

// eventsHandler streams Server-Sent Events: the current state at once, then a new
// one after every change, so Electron main never has to poll. An SSE message is
// plain text, "event: <name>", "data: <one line>", and a blank line to end it.
func eventsHandler(rt Router, list func() ([]models.Model, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "no_streaming", "streaming is not supported")
			return
		}
		// Subscribe before the first read, so a change in between is not lost.
		changed, cancel := rt.Subscribe()
		defer cancel()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		send := func() bool {
			body, err := currentState(rt, list)
			if err != nil {
				return true // keep the stream; the next change may succeed
			}
			data, _ := json.Marshal(body) // json.Marshal emits a single line
			if _, err := fmt.Fprintf(w, "event: state\ndata: %s\n\n", data); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}

		if !send() {
			return
		}
		for {
			select {
			case <-changed:
				if !send() {
					return
				}
			case <-r.Context().Done():
				return
			}
		}
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
func unloadHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rt.Unload(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "model_not_loaded", "that model is not loaded")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": stateStopped})
	}
}
