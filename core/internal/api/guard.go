package api

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// guard rejects requests that do not come from our own Electron main process.
// Any local program, or a web page in the user's browser, can reach 127.0.0.1,
// so the Host check (stops DNS rebinding) and the bearer token (stops other
// programs) both have to pass before a handler runs.
func guard(token string, port int, next http.Handler) http.Handler {
	wantHost := fmt.Sprintf("127.0.0.1:%d", port)
	wantAuth := []byte("Bearer " + token)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A rebinding page reaches us under its own domain name, so the Host differs.
		if r.Host != wantHost {
			writeError(w, http.StatusForbidden, "forbidden_host", "unexpected Host header")
			return
		}
		// Constant-time compare so response timing cannot leak the token.
		got := []byte(strings.TrimSpace(r.Header.Get("Authorization")))
		if subtle.ConstantTimeCompare(got, wantAuth) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or wrong token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
}

// writeConflict is writeError plus the section as it is now, so the client can merge and retry.
func writeConflict(w http.ResponseWriter, message string, current any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": "config_conflict", "message": message, "current": current})
}
