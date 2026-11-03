package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"

	"github.com/countingticks/openvatra/core/internal/router"
)

// maxRequestBody caps what we buffer to read the "model" field. Chat requests with
// inline images are large, but not this large.
const maxRequestBody = 64 << 20

// Router hands out a ready llama-server for a request. *router.Router satisfies it.
type Router interface {
	Acquire(ctx context.Context, kind router.Kind, model string) (baseURL string, release func(), err error)
}

// proxy forwards a request to the llama-server the router picks. Chat requests
// choose the model by the "model" field of the JSON body; embeddings always go to
// the chosen embedding model, so their body is passed through unread.
func proxy(rt Router, kind router.Kind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "body_unreadable", "request body too large or unreadable")
			return
		}

		var model string
		if kind == router.Chat {
			var req struct {
				Model string `json:"model"`
			}
			if err := json.Unmarshal(body, &req); err != nil || req.Model == "" {
				writeError(w, http.StatusBadRequest, "bad_request", `body must be JSON with a "model" field`)
				return
			}
			model = req.Model
		}

		base, release, err := rt.Acquire(r.Context(), kind, model)
		if err != nil {
			writeAcquireError(w, r, err)
			return
		}
		// Held until the reply is completely sent, so a swap never cuts off a stream.
		defer release()

		target, err := url.Parse(base)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "bad_backend", "invalid model server address")
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
			ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
				writeError(w, http.StatusBadGateway, "backend_failed", "the model server did not answer")
			},
		}).ServeHTTP(w, r)
	}
}

func writeAcquireError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, router.ErrUnknownModel):
		writeError(w, http.StatusNotFound, "model_not_found", "no model with that name in the models folder")
	case errors.Is(err, router.ErrNoEmbeddingModel):
		writeError(w, http.StatusConflict, "no_embedding_model", "no embedding model has been chosen")
	case r.Context().Err() != nil:
		// The client left while waiting for the model; nobody is listening for a reply.
	default:
		writeError(w, http.StatusServiceUnavailable, "model_load_failed", err.Error())
	}
}
