package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"

	"github.com/countingticks/openvatra/core/internal/router"
)

// maxRequestBody caps what we buffer to read the "model" field. Chat requests with
// inline images are large, but not this large.
const maxRequestBody = 64 << 20

// Router hands out ready llama-servers and reports on them. *router.Router satisfies it.
type Router interface {
	Acquire(ctx context.Context, kind router.Kind, model string) (baseURL string, release func(), err error)
	Snapshot() []router.ModelState
	Subscribe() (<-chan struct{}, func())
	Load(ctx context.Context, id string) error
	Unload(id string) bool
	Notify()
}

// proxy forwards a request to the llama-server the router picks. Chat requests
// choose the model by the "model" field of the JSON body; embeddings always go to
// the chosen embedding model, so their body is passed through unread.
func proxy(rt Router, kind router.Kind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
		if err != nil {
			writeError(w, r, &Error{Status: http.StatusRequestEntityTooLarge, Code: "body_unreadable", Message: "request body too large or unreadable"})
			return
		}

		var model string
		if kind == router.Chat {
			var req struct {
				Model string `json:"model"`
			}
			if err := json.Unmarshal(body, &req); err != nil || req.Model == "" {
				writeError(w, r, &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: `body must be JSON with a "model" field`})
				return
			}
			model = req.Model
		}

		base, release, err := rt.Acquire(r.Context(), kind, model)
		if err != nil {
			writeError(w, r, acquireError(err))
			return
		}
		// Held until the reply is completely sent, so a swap never cuts off a stream.
		defer release()

		target, err := url.Parse(base)
		if err != nil {
			writeError(w, r, &Error{Status: http.StatusInternalServerError, Code: "bad_backend", Message: "invalid model server address"})
			return
		}
		(&httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(target)
				// The token is for core; the model server must never see it.
				pr.Out.Header.Del("Authorization")
				pr.Out.Body = io.NopCloser(bytes.NewReader(body))
			},
			// -1 flushes after every write, which is what keeps Server-Sent Events
			// (stream: true) arriving token by token instead of in one lump at the end.
			FlushInterval: -1,
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, _ error) {
				writeError(w, r, &Error{Status: http.StatusBadGateway, Code: "backend_failed", Message: "the model server did not answer"})
			},
		}).ServeHTTP(w, r)
	}
}
