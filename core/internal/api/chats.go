package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/store"
)

// maxChatBody is the size limit for JSON bodies of the chat endpoints (SPEC-chat.md: 10 MB).
const maxChatBody = 10 << 20

// registerChats adds the chat endpoints. Without a service (the chat database could not be opened) each one
// answers 503 with a plain reason, instead of the route not existing.
func registerChats(mux *http.ServeMux, svc *chat.Service) {
	h := func(f func(*chat.Service, http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if svc == nil || svc.Store == nil {
				writeCode(w, http.StatusServiceUnavailable, "chat_unavailable", "chat storage is not available")
				return
			}
			f(svc, w, r)
		}
	}
	mux.HandleFunc("GET /api/chats", h(listChats))
	mux.HandleFunc("POST /api/chats", h(createChat))
	mux.HandleFunc("GET /api/chats/{id}", h(getChat))
	mux.HandleFunc("PATCH /api/chats/{id}", h(patchChat))
	mux.HandleFunc("DELETE /api/chats/{id}", h(deleteChat))
	mux.HandleFunc("POST /api/chats/{id}/messages", h(sendMessage))
	mux.HandleFunc("POST /api/chats/{id}/regenerate", h(regenerate))
	mux.HandleFunc("GET /api/chats/{id}/export", h(exportChat))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxChatBody)).Decode(v); err != nil {
		writeCode(w, http.StatusBadRequest, "bad_request", "the request body is not valid JSON")
		return false
	}
	return true
}

// writeStoreError maps the errors the chat code returns to HTTP answers.
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeCode(w, http.StatusNotFound, "chat_not_found", "no chat with that id")
	case errors.Is(err, chat.ErrBadInput):
		writeCode(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		writeCode(w, http.StatusInternalServerError, "chat_failed", "chat storage failed")
	}
}

func listChats(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	chats, err := svc.Store.ListChats(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chats)
}

func createChat(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model     string `json:"model"`
		WebSearch bool   `json:"webSearch"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Model == "" {
		writeCode(w, http.StatusBadRequest, "bad_request", `"model" is required`)
		return
	}
	c, err := svc.Store.CreateChat(r.Context(), req.Model, req.WebSearch)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func getChat(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	c, err := svc.Store.GetChat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	msgs, err := svc.Store.Messages(r.Context(), c.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chat": c, "messages": msgs})
}

func patchChat(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title     *string `json:"title"`
		Model     *string `json:"model"`
		WebSearch *bool   `json:"webSearch"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	c, err := svc.Store.UpdateChat(r.Context(), r.PathValue("id"),
		store.ChatUpdate{Title: req.Title, Model: req.Model, WebSearch: req.WebSearch})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func deleteChat(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	if err := svc.Store.DeleteChat(r.Context(), r.PathValue("id")); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func exportChat(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	c, err := svc.Store.GetChat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	msgs, err := svc.Store.Messages(r.Context(), c.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = fmt.Fprint(w, chat.Markdown(c, msgs))
}

func sendMessage(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text        string `json:"text"`
		ReplaceLast bool   `json:"replaceLast"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	streamTurn(w, r, func(emit func(chat.Event)) error {
		return svc.Send(r.Context(), r.PathValue("id"), chat.Input{Text: req.Text, ReplaceLast: req.ReplaceLast}, emit)
	})
}

func regenerate(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	streamTurn(w, r, func(emit func(chat.Event)) error {
		return svc.Regenerate(r.Context(), r.PathValue("id"), emit)
	})
}

// streamTurn runs a turn and writes its events as Server-Sent Events. The headers go out with the first event, so
// an error before any event (unknown chat, empty message) is still an ordinary JSON error with a status code.
// When the client closes the connection r.Context() is cancelled, which stops the request to llama-server.
func streamTurn(w http.ResponseWriter, r *http.Request, run func(emit func(chat.Event)) error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeCode(w, http.StatusInternalServerError, "no_streaming", "streaming is not supported here")
		return
	}
	began := false
	emit := func(e chat.Event) {
		if !began {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			began = true
		}
		data, _ := json.Marshal(e.Data) // JSON keeps newlines in text deltas out of the SSE framing
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Name, data)
		flusher.Flush()
	}
	if err := run(emit); err != nil && !began {
		writeStoreError(w, err)
	}
}
