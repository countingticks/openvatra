// Package api holds the HTTP handlers of core.
package api

import (
	"encoding/json"
	"net/http"
)

// NewHandler returns the router for every core endpoint, behind the token and
// Host checks. port is the one core listens on; shutdown is called (once the
// reply is sent) when a client asks core to stop.
func NewHandler(token string, port int, shutdown func()) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
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

func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
