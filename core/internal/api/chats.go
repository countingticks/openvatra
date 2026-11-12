package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"

	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/store"
)

// maxChatBody is the size limit of a message body (SPEC-chat.md: 10 MB); the other chat routes take the usual 1 MiB.
const maxChatBody = 10 << 20

type ChatPath struct {
	ID string `path:"id"`
}

type CreateChat struct {
	Model     string `json:"model"`
	WebSearch bool   `json:"webSearch,omitempty"`
}

func (c CreateChat) Validate() error {
	if c.Model == "" {
		return &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: `"model" is required`}
	}
	return nil
}

type UpdateChat struct {
	ID        string  `path:"id"`
	Title     *string `json:"title,omitempty"`
	Model     *string `json:"model,omitempty"`
	WebSearch *bool   `json:"webSearch,omitempty"`
}

type ChatWithMessages struct {
	Chat     store.Chat      `json:"chat"`
	Messages []store.Message `json:"messages"`
}

var errChatUnavailable = &Error{Status: http.StatusServiceUnavailable, Code: "chat_unavailable",
	Message: "chat storage is not available"}

// chatRoutes are the chat endpoints. Without a service (the chat database could not be opened) each one answers 503
// with a plain reason, instead of the route not existing.
func chatRoutes(svc *chat.Service) []Route {
	ready := func() error {
		if svc == nil || svc.Store == nil {
			return errChatUnavailable
		}
		return nil
	}
	raw := func(h func(w http.ResponseWriter, r *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if err := ready(); err != nil {
				writeError(w, r, err)
				return
			}
			h(w, r)
		}
	}
	chatPath := reflect.TypeFor[ChatPath]()

	return []Route{
		JSON(http.MethodGet, "/api/chats", UI, "listChats", "List the chats, newest first",
			func(ctx context.Context, _ struct{}) ([]store.Chat, error) {
				if err := ready(); err != nil {
					return nil, err
				}
				chats, err := svc.Store.ListChats(ctx)
				if chats == nil {
					chats = []store.Chat{}
				}
				return chats, err
			}).
			WithErrors("chat_unavailable", "internal"),
		JSON(http.MethodPost, "/api/chats", UI, "createChat", "Start a chat",
			func(ctx context.Context, in CreateChat) (store.Chat, error) {
				if err := ready(); err != nil {
					return store.Chat{}, err
				}
				return svc.Store.CreateChat(ctx, in.Model, in.WebSearch)
			}).
			WithStatus(http.StatusCreated).
			WithErrors("invalid_request", "bad_request", "chat_unavailable", "internal"),
		JSON(http.MethodGet, "/api/chats/{id}", UI, "getChat", "One chat with its messages",
			func(ctx context.Context, in ChatPath) (ChatWithMessages, error) {
				if err := ready(); err != nil {
					return ChatWithMessages{}, err
				}
				c, err := svc.Store.GetChat(ctx, in.ID)
				if err != nil {
					return ChatWithMessages{}, err
				}
				msgs, err := svc.Store.Messages(ctx, c.ID)
				if msgs == nil {
					msgs = []store.Message{}
				}
				return ChatWithMessages{c, msgs}, err
			}).
			WithErrors("chat_unavailable", "chat_not_found", "internal"),
		JSON(http.MethodPatch, "/api/chats/{id}", UI, "updateChat", "Change a chat's title, model or web search",
			func(ctx context.Context, in UpdateChat) (store.Chat, error) {
				if err := ready(); err != nil {
					return store.Chat{}, err
				}
				return svc.Store.UpdateChat(ctx, in.ID,
					store.ChatUpdate{Title: in.Title, Model: in.Model, WebSearch: in.WebSearch})
			}).
			WithErrors("invalid_request", "chat_unavailable", "chat_not_found", "bad_request", "internal"),
		JSON(http.MethodDelete, "/api/chats/{id}", UI, "deleteChat", "Delete a chat",
			func(ctx context.Context, in ChatPath) (NoContent, error) {
				if err := ready(); err != nil {
					return NoContent{}, err
				}
				return NoContent{}, svc.Store.DeleteChat(ctx, in.ID)
			}).
			WithErrors("chat_unavailable", "chat_not_found", "internal"),
		Raw(http.MethodGet, "/api/chats/{id}/export", UI, "exportChat", "A chat as Markdown",
			raw(func(w http.ResponseWriter, r *http.Request) { exportChat(svc, w, r) })).
			WithDoc(chatPath, nil, "text/markdown").
			WithErrors("chat_unavailable", "chat_not_found", "internal"),
		Raw(http.MethodPost, "/api/chats/{id}/messages", UI, "sendMessage", "Send a message and stream the reply",
			raw(func(w http.ResponseWriter, r *http.Request) { sendMessage(svc, w, r) })).
			WithDoc(chatPath, nil, "").
			WithStream(StreamDoc{}).
			WithErrors("chat_unavailable", "chat_not_found", "bad_request", "no_streaming", "internal"),
		Raw(http.MethodPost, "/api/chats/{id}/regenerate", UI, "regenerate", "Answer the last message again, streamed",
			raw(func(w http.ResponseWriter, r *http.Request) { regenerate(svc, w, r) })).
			WithDoc(chatPath, nil, "").
			WithStream(StreamDoc{}).
			WithErrors("chat_unavailable", "chat_not_found", "bad_request", "no_streaming", "internal"),
	}
}

func exportChat(svc *chat.Service, w http.ResponseWriter, r *http.Request) {
	c, err := svc.Store.GetChat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	msgs, err := svc.Store.Messages(r.Context(), c.ID)
	if err != nil {
		writeError(w, r, err)
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
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxChatBody)).Decode(&req); err != nil {
		writeError(w, r, &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: "the request body is not valid JSON"})
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
		writeError(w, r, &Error{Status: http.StatusInternalServerError, Code: "no_streaming", Message: "streaming is not supported here"})
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
		writeError(w, r, err)
	}
}
