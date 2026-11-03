// Package api holds the HTTP handlers of core.
package api

import (
	"encoding/json"
	"net/http"
)

// NewHandler returns the router for every core endpoint, behind the token and
// Host checks. port is the one core listens on.
func NewHandler(token string, port int) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	return guard(token, port, mux)
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
