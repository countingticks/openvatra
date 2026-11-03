// Package api holds the HTTP handlers of core.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

// NewHandler returns the router for every core endpoint, behind the token and
// Host checks. port is the one core listens on; shutdown is called (once the
// reply is sent) when a client asks core to stop; listModels reports the models
// currently on disk (a function, because the folder will change at runtime); rt
// picks the model server for the chat and embedding endpoints.
func NewHandler(token string, port int, shutdown func(), listModels func() ([]models.Model, error), rt Router) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /v1/models", modelList(listModels))
	mux.HandleFunc("POST /v1/chat/completions", proxy(rt, router.Chat))
	mux.HandleFunc("POST /v1/embeddings", proxy(rt, router.Embedding))
	mux.HandleFunc("POST /shutdown", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "shutting_down"})
		// Only signal; the caller stops the server after this handler returns,
		// so the 202 above still reaches the client.
		shutdown()
	})
	return guard(token, port, mux)
}

// modelList answers in the shape OpenAI clients (Open WebUI, OpenCode) expect.
func modelList(list func() ([]models.Model, error)) http.HandlerFunc {
	type entry struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	return func(w http.ResponseWriter, _ *http.Request) {
		found, err := list()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "models_unreadable", "could not read the models folder")
			return
		}
		data := make([]entry, 0, len(found)) // [] rather than null when empty
		for _, m := range found {
			data = append(data, entry{ID: m.ID, Object: "model", OwnedBy: "openvatra"})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
	}
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
