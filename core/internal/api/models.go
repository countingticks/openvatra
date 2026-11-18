package api

import (
	"context"
	"net/http"
	"slices"
	"strconv"

	"github.com/countingticks/openvatra/core/internal/feed"
	"github.com/countingticks/openvatra/core/internal/fit"
	"github.com/countingticks/openvatra/core/internal/provider"
)

// ModelPath is the input of the routes that name one model.
type ModelPath struct {
	ID string `path:"id"`
}

// FitQuery is the input of GET /api/models/{id}/fit.
type FitQuery struct {
	ID        string `path:"id"`
	Context   string `query:"context" doc:"auto, or a whole number from 2048 to 1048576; default auto"`
	Placement string `query:"placement" doc:"auto, gpu, experts, layers or cpu; default auto"`
}

const (
	minFitContext = 2048
	maxFitContext = 1048576
)

var fitPlacements = []string{fit.PlaceAuto, fit.PlaceGPU, fit.PlaceExperts, fit.PlaceLayers, fit.PlaceCPU}

// parseFitQuery reads the query's context (0 = auto) and placement, with their defaults.
func parseFitQuery(in FitQuery) (int, string, error) {
	size := 0
	if in.Context != "" && in.Context != "auto" {
		n, err := strconv.Atoi(in.Context)
		if err != nil || n < minFitContext || n > maxFitContext {
			return 0, "", invalidRequest("context must be auto or a whole number from 2048 to 1048576")
		}
		size = n
	}
	placement := in.Placement
	if placement == "" {
		placement = fit.PlaceAuto
	}
	if !slices.Contains(fitPlacements, placement) {
		return 0, "", invalidRequest("placement must be auto, gpu, experts, layers or cpu")
	}
	return size, placement, nil
}

var errModelsUnreadable = &Error{Status: http.StatusInternalServerError, Code: "models_unreadable",
	Message: "could not read the models folder"}

func modelRoutes(d Deps) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/models", UI, "listModels", "List the models on disk with their state",
			func(context.Context, struct{}) (feed.StateBody, error) {
				body, err := feed.State(d.Resident, d.ListModels, d.Choose)
				if err != nil {
					return feed.StateBody{}, errModelsUnreadable
				}
				return body, nil
			}).
			WithErrors("models_unreadable"),
		JSON(http.MethodGet, "/api/models/{id}/fit", UI, "getModelFit",
			"Say what a context size and placement would mean for a model, without loading it",
			func(_ context.Context, in FitQuery) (fit.Choice, error) {
				size, placement, err := parseFitQuery(in)
				if err != nil {
					return fit.Choice{}, err
				}
				if d.Fit == nil {
					return fit.Choice{}, errModelsUnreadable
				}
				choice, err := d.Fit(in.ID, size, placement)
				if e := toError(err); err != nil {
					if e.Code == "internal" { // Discover failed
						return fit.Choice{}, errModelsUnreadable
					}
					return fit.Choice{}, e
				}
				return choice, nil
			}).
			WithErrors("model_not_found", "invalid_request", "models_unreadable"),
		JSON(http.MethodPost, "/api/models/{id}/load", UI, "loadModel", "Load a model and answer once it is ready",
			func(ctx context.Context, in ModelPath) (StatusBody, error) {
				if err := d.Resident.Load(ctx, in.ID); err != nil {
					return StatusBody{}, acquireError(err)
				}
				return StatusBody{provider.StateReady}, nil
			}).
			WithErrors("model_not_found", "no_embedding_model", "model_load_failed"),
		// 202: the server may still be finishing a reply and stops in the background.
		JSON(http.MethodPost, "/api/models/{id}/unload", UI, "unloadModel", "Unload a model",
			func(_ context.Context, in ModelPath) (StatusBody, error) {
				if !d.Resident.Unload(in.ID) {
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
				d.Resident.Notify()
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
