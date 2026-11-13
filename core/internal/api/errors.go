package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/removal"
	"github.com/countingticks/openvatra/core/internal/router"
	"github.com/countingticks/openvatra/core/internal/store"
)

// Error is an answer other than success. Code is stable (the UI branches on it); Message is one sentence a person
// can read; Extra is added to the body, e.g. {"current": …} on a config conflict.
type Error struct {
	Status  int
	Code    string
	Message string
	Extra   map[string]any
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// ErrorBody is the shape of every error on the wire.
type ErrorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Current any    `json:"current,omitempty" doc:"409 config_conflict only: the section as it is now"`
}

// mapped is one row of the table that turns package errors into answers.
type mapped struct {
	err     error
	status  int
	code    string
	message string // "" = the error's own text
}

var errorTable = []mapped{
	{config.ErrUnknownSection, http.StatusNotFound, "unknown_section", "no such config section"},
	{config.ErrConflict, http.StatusConflict, "config_conflict", "the section changed since it was read"},
	{config.ErrUnavailable, http.StatusServiceUnavailable, "config_unavailable", "config storage is not available"},
	{catalog.ErrUnknown, http.StatusNotFound, "unknown_model", "not a catalog model"},
	{downloads.ErrUnknown, http.StatusNotFound, "unknown_model", "not a catalog model"},
	{removal.ErrUnknownEntry, http.StatusNotFound, "unknown_catalog_entry", ""},
	{removal.ErrOutside, http.StatusConflict, "outside_models_folder", ""},
	{removal.ErrNotInstalled, http.StatusConflict, "not_installed", ""},
	{removal.ErrUnloadTimeout, http.StatusConflict, "unload_timeout", ""},
	// The fixed sentence, not the shell's error it wraps.
	{removal.ErrTrashFailed, http.StatusInternalServerError, "trash_failed", removal.ErrTrashFailed.Error()},
	{catalog.ErrNoFolder, http.StatusConflict, "no_models_folder", "no models folder is set"},
	{downloads.ErrNoFolder, http.StatusConflict, "no_models_folder", "no models folder is set"},
	{downloads.ErrNoDownload, http.StatusNotFound, "no_download", "there is no such download"},
	{downloads.ErrInstalled, http.StatusConflict, "already_installed", "that model is already installed"},
	{downloads.ErrNoSpace, http.StatusConflict, "not_enough_space", "not enough disk space"},
	{downloads.ErrNotResumable, http.StatusConflict, "not_paused", "only a paused or failed download can be resumed"},
	{router.ErrUnknownModel, http.StatusNotFound, "model_not_found", "no model with that name in the models folder"},
	{router.ErrNoEmbeddingModel, http.StatusConflict, "no_embedding_model", "no embedding model has been chosen"},
	{store.ErrNotFound, http.StatusNotFound, "chat_not_found", "no chat with that id"},
	{chat.ErrBadInput, http.StatusBadRequest, "bad_request", ""},
}

// toError turns any error into the answer the client gets; an error with no mapping is 500 internal.
func toError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	var invalid *config.InvalidError
	if errors.As(err, &invalid) {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_config", Message: invalid.Message}
	}
	for _, m := range errorTable {
		if errors.Is(err, m.err) {
			msg := m.message
			if msg == "" {
				msg = err.Error()
			}
			return &Error{Status: m.status, Code: m.code, Message: msg}
		}
	}
	return &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "core hit an unexpected error"}
}

// writeError is the one error path. When the client has gone (its request's context is done) nobody is listening,
// so nothing is written.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return
	}
	e := toError(err)
	if e.Code == "internal" {
		info := requestInfoFrom(r)
		info.logger.Error("request failed", "op", info.op, "err", err)
	}
	body := make(map[string]any, 2+len(e.Extra))
	for k, v := range e.Extra {
		body[k] = v
	}
	body["error"], body["message"] = e.Code, e.Message
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(body)
}

// requestInfo is what newMux puts in each request's context for the error path.
type requestInfo struct {
	logger *slog.Logger
	op     string
}

type requestInfoKey struct{}

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func requestInfoFrom(r *http.Request) requestInfo {
	if info, ok := r.Context().Value(requestInfoKey{}).(requestInfo); ok {
		return info
	}
	return requestInfo{logger: discard}
}
