package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/feed"
)

// Downloads is what the download endpoints and the event need; *downloads.Manager in production, a stub in tests.
type Downloads interface {
	Items() []downloads.DownloadItem
	Subscribe() (<-chan struct{}, func())
	Start(id string) error
	StartEngine() error
	Resume(id string) error
	Cancel(id string) error
}

// StartDownload queues a catalog model, or the CUDA engine.
type StartDownload struct {
	CatalogID string `json:"catalogId,omitempty"`
	Engine    string `json:"engine,omitempty" enum:"cuda"`
}

func (s StartDownload) Validate() error {
	if (s.CatalogID == "") == (s.Engine == "") {
		return &Error{Status: http.StatusBadRequest, Code: "bad_request",
			Message: `send exactly one of "catalogId" or "engine"`}
	}
	return nil
}

func downloadRoutes(dl Downloads) []Route {
	accepted := StatusBody{"accepted"}
	return []Route{
		JSON(http.MethodGet, "/api/downloads", UI, "listDownloads", "The download queue",
			func(context.Context, struct{}) (feed.DownloadsBody, error) {
				var items []downloads.DownloadItem
				if dl != nil {
					items = dl.Items()
				}
				if items == nil {
					items = []downloads.DownloadItem{}
				}
				return feed.DownloadsBody{Items: items}, nil
			}),
		JSON(http.MethodPost, "/api/downloads", UI, "startDownload", "Queue a catalog model or the CUDA engine",
			func(_ context.Context, in StartDownload) (StatusBody, error) {
				if in.Engine != "" {
					return accepted, dl.StartEngine()
				}
				return accepted, dl.Start(in.CatalogID)
			}).
			WithStatus(http.StatusAccepted).
			WithErrors("invalid_request", "bad_request", "unknown_model", "no_models_folder", "already_installed",
				"not_enough_space", "internal"),
		JSON(http.MethodDelete, "/api/downloads/{id}", UI, "cancelDownload", "Cancel a download and drop its partial files",
			func(_ context.Context, in ModelPath) (StatusBody, error) { return accepted, dl.Cancel(in.ID) }).
			WithStatus(http.StatusAccepted).
			WithErrors("unknown_model", "no_download", "internal"),
		JSON(http.MethodPost, "/api/downloads/{id}/resume", UI, "resumeDownload", "Resume a paused or failed download",
			func(_ context.Context, in ModelPath) (StatusBody, error) { return accepted, dl.Resume(in.ID) }).
			WithStatus(http.StatusAccepted).
			WithErrors("unknown_model", "no_download", "no_models_folder", "already_installed", "not_enough_space",
				"not_paused", "internal"),
	}
}
