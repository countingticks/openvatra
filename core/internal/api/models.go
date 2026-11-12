package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/feed"
	"github.com/countingticks/openvatra/core/internal/router"
)

// ModelPath is the input of the routes that name one model.
type ModelPath struct {
	ID string `path:"id"`
}

var errModelsUnreadable = &Error{Status: http.StatusInternalServerError, Code: "models_unreadable",
	Message: "could not read the models folder"}

func modelRoutes(d Deps) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/models", UI, "listModels", "List the models on disk with their state",
			func(context.Context, struct{}) (feed.StateBody, error) {
				body, err := feed.State(d.Router, d.ListModels)
				if err != nil {
					return feed.StateBody{}, errModelsUnreadable
				}
				return body, nil
			}).
			WithErrors("models_unreadable"),
		JSON(http.MethodPost, "/api/models/{id}/load", UI, "loadModel", "Load a model and answer once it is ready",
			func(ctx context.Context, in ModelPath) (StatusBody, error) {
				if err := d.Router.Load(ctx, in.ID); err != nil {
					return StatusBody{}, acquireError(err)
				}
				return StatusBody{router.StateReady}, nil
			}).
			WithErrors("model_not_found", "no_embedding_model", "model_load_failed"),
		// 202: the server may still be finishing a reply and stops in the background.
		JSON(http.MethodPost, "/api/models/{id}/unload", UI, "unloadModel", "Unload a model",
			func(_ context.Context, in ModelPath) (StatusBody, error) {
				if !d.Router.Unload(in.ID) {
					return StatusBody{}, &Error{Status: http.StatusNotFound, Code: "model_not_loaded",
						Message: "that model is not loaded"}
				}
				return StatusBody{feed.StateStopped}, nil
			}).
			WithStatus(http.StatusAccepted).
			WithErrors("model_not_loaded"),
		// For changes core can't see itself: main moves a removed model to the Recycle Bin, and the list has to drop
		// it.
		JSON(http.MethodPost, "/api/models/refresh", UI, "refreshModels", "Tell every listener to re-read the models folder",
			func(context.Context, struct{}) (StatusBody, error) {
				d.Router.Notify()
				return StatusBody{"refreshing"}, nil
			}).
			WithStatus(http.StatusAccepted),
	}
}

// acquireError is the answer when a model could not be started: a mapped error as the table says, anything else 503
// with its text (the reason llama-server gave).
func acquireError(err error) error {
	if e := toError(err); e.Code != "internal" {
		return e
	}
	return &Error{Status: http.StatusServiceUnavailable, Code: "model_load_failed", Message: err.Error()}
}
