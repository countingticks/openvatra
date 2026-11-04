package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/downloads"
)

// Downloads is what the download endpoints and the event need; *downloads.Manager in production, a stub in tests.
type Downloads interface {
	Items() []downloads.Item
	Subscribe() (<-chan struct{}, func())
	Start(id string) error
	StartEngine() error
	Resume(id string) error
	Cancel(id string) error
}

// writeDownloadError turns the queue's errors into answers the UI can act on.
func writeDownloadError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, downloads.ErrUnknown):
		writeError(w, http.StatusNotFound, "unknown_model", "not a catalog model")
	case errors.Is(err, downloads.ErrNoDownload):
		writeError(w, http.StatusNotFound, "no_download", "there is no such download")
	case errors.Is(err, downloads.ErrNoFolder):
		writeError(w, http.StatusConflict, "no_models_folder", "no models folder is set")
	case errors.Is(err, downloads.ErrInstalled):
		writeError(w, http.StatusConflict, "already_installed", "that model is already installed")
	case errors.Is(err, downloads.ErrNoSpace):
		writeError(w, http.StatusConflict, "not_enough_space", "not enough disk space")
	case errors.Is(err, downloads.ErrNotResumable):
		writeError(w, http.StatusConflict, "not_paused", "only a paused or failed download can be resumed")
	default:
		writeError(w, http.StatusInternalServerError, "download_failed", "could not start the download")
	}
}

func accepted(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

// startDownloadHandler queues a catalog model, or the CUDA engine for {"engine":"cuda"}.
func startDownloadHandler(dl Downloads) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CatalogID string `json:"catalogId"`
			Engine    string `json:"engine"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil || (body.CatalogID == "") == (body.Engine == "") {
			writeError(w, http.StatusBadRequest, "bad_request", `send exactly one of "catalogId" or "engine"`)
			return
		}
		start := func() error { return dl.Start(body.CatalogID) }
		if body.Engine != "" {
			if body.Engine != "cuda" {
				writeError(w, http.StatusBadRequest, "bad_request", `the only engine is "cuda"`)
				return
			}
			start = dl.StartEngine
		}
		if err := start(); err != nil {
			writeDownloadError(w, err)
			return
		}
		accepted(w)
	}
}

func cancelDownloadHandler(dl Downloads) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := dl.Cancel(r.PathValue("id")); err != nil {
			writeDownloadError(w, err)
			return
		}
		accepted(w)
	}
}

func resumeDownloadHandler(dl Downloads) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := dl.Resume(r.PathValue("id")); err != nil {
			writeDownloadError(w, err)
			return
		}
		accepted(w)
	}
}
