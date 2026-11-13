package api

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strings"
)

type scopeKey struct{}

// withScope puts the caller's scope in ctx; the gate calls it once the token is checked.
func withScope(ctx context.Context, s Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

// callerScope is the scope of the token the request carried; None when the gate set nothing (/health).
func callerScope(ctx context.Context) Scope {
	s, _ := ctx.Value(scopeKey{}).(Scope)
	return s
}

// covers reports whether a caller with scope have may call a row that needs scope need.
func covers(have, need Scope) bool {
	return need == None || have == Shell || have == need
}

// gate lets a request reach next only when it comes from this PC, under core's own Host, from no page or an
// allowed page, and with a live token. Any local program, or a web page in the user's browser, can reach
// 127.0.0.1: the Host check stops DNS rebinding, the Origin check stops other pages, the token stops other
// programs. The row's scope is checked in newMux, which knows the row.
func gate(t *tokens, port int, origins []string, next http.Handler) http.Handler {
	wantHost := fmt.Sprintf("127.0.0.1:%d", port)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !fromLoopback(r.RemoteAddr) {
			writeError(w, r, &Error{Status: http.StatusForbidden, Code: "forbidden_remote", Message: "requests must come from this PC"})
			return
		}
		// A rebinding page reaches us under its own domain name, so the Host differs.
		if r.Host != wantHost {
			writeError(w, r, &Error{Status: http.StatusForbidden, Code: "forbidden_host", Message: "unexpected Host header"})
			return
		}
		if origin := r.Header.Values("Origin"); len(origin) > 0 {
			o := origin[0]
			if len(origin) != 1 || !slices.Contains(origins, o) {
				writeError(w, r, &Error{Status: http.StatusForbidden, Code: "forbidden_origin", Message: "this page's origin may not call core"})
				return
			}
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", o)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Expose-Headers", "Content-Type")
			// Browsers never send a token on a preflight, so it is answered here without one.
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		tok, ok := strings.CutPrefix(strings.TrimSpace(r.Header.Get("Authorization")), "Bearer ")
		scope, live := t.scopeOf(tok)
		if !ok || !live {
			writeError(w, r, &Error{Status: http.StatusUnauthorized, Code: "unauthorized", Message: "missing or wrong token"})
			return
		}
		next.ServeHTTP(w, r.WithContext(withScope(r.Context(), scope)))
	})
}

func fromLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
