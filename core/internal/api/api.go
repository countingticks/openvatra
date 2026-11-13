// Package api holds the HTTP handlers of core.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"reflect"
	"sync"

	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

// Deps is everything the routes reach.
type Deps struct {
	Token    string   // the shell token (OPENVATRA_CORE_TOKEN)
	Origins  []string // --origin values; a request with any other Origin is refused
	Port     int
	Version  string
	Shutdown func() // called once the reply is sent, when a client asks core to stop
	// ListModels reports the models on disk now (a function: the folder changes at runtime).
	ListModels func() ([]models.Model, error)
	Router     Router
	Config     Config // nil only in tests: the config routes answer 503
	Hardware   Hardware
	Catalog    Catalog
	Removal    Removal // nil only in tests that do not call the route
	Downloads  Downloads
	Engines    func() downloads.EnginesBody // the llama.cpp builds on disk; nil = an unknown bundled build only
	Chats      *chat.Service                // nil when the chat database could not be opened
	Log        event.Log
	Logger     *slog.Logger // nil = discard
}

// APILevel is the contract's major version; it changes only when a change breaks existing clients.
const APILevel = 1

type StatusBody struct {
	Status string `json:"status"`
}

type VersionBody struct {
	Version string `json:"version"`
	API     int    `json:"api"`
}

type TokenRequest struct {
	Scope string `json:"scope" doc:"only \"ui\" can be issued"`
}

type TokenBody struct {
	Token string `json:"token" doc:"a ui-scoped token for this core run; send it as Authorization: Bearer"`
}

// Routes builds the table. Dependencies are captured, never called here, so nil ones are fine for the document.
func Routes(d Deps) []Route {
	return routes(d, newTokens(d.Token))
}

// routes is Routes with the token store the gate checks against, so a token issued here works at once.
func routes(d Deps, t *tokens) []Route {
	routes := []Route{
		JSON(http.MethodGet, "/health", None, "health", "Report that core is up",
			func(context.Context, struct{}) (StatusBody, error) { return StatusBody{"ok"}, nil }),
		JSON(http.MethodGet, "/api/version", UI, "getVersion", "Core's version and the contract's version",
			func(context.Context, struct{}) (VersionBody, error) { return VersionBody{d.Version, APILevel}, nil }),
		Raw(http.MethodGet, "/api/events", UI, "streamEvents", "Stream the event log as Server-Sent Events",
			eventsHandler(d.Log, keepaliveInterval)).
			WithDoc(reflect.TypeFor[EventsQuery](), nil, "").
			WithStream(StreamDoc{Schema: eventStreamSchema}).
			WithErrors("invalid_after", "invalid_filter", "no_streaming", "event_log_failed"),
	}
	routes = append(routes, Raw(http.MethodGet, "/api/openapi.json", UI, "getOpenapi",
		"Core's OpenAPI document", openapiHandler(d)))
	routes = append(routes, modelRoutes(d)...)
	routes = append(routes, hardwareRoutes(d.Hardware)...)
	routes = append(routes, catalogRoutes(d.Catalog, d.Removal)...)
	routes = append(routes, downloadRoutes(d.Downloads)...)
	routes = append(routes, engineRoutes(d.Engines)...)
	routes = append(routes, configRoutes(d.Config)...)
	routes = append(routes, chatRoutes(d.Chats)...)
	return append(routes,
		Raw(http.MethodGet, "/v1/models", UI, "openaiModels", "List the models on disk, OpenAI style",
			modelList(d.ListModels)).
			WithErrors("models_unreadable"),
		Raw(http.MethodPost, "/v1/chat/completions", UI, "openaiChatCompletions", "Chat with a model, OpenAI style",
			proxy(d.Router, router.Chat)).
			WithErrors("body_unreadable", "bad_request", "model_not_found", "model_load_failed", "bad_backend",
				"backend_failed"),
		Raw(http.MethodPost, "/v1/embeddings", UI, "openaiEmbeddings", "Embed text with the embedding model, OpenAI style",
			proxy(d.Router, router.Embedding)).
			WithErrors("body_unreadable", "no_embedding_model", "model_load_failed", "bad_backend", "backend_failed"),
		JSON(http.MethodPost, "/api/tokens", Shell, "issueToken", "Issue a token for the app's window",
			func(_ context.Context, in TokenRequest) (TokenBody, error) {
				if in.Scope != "ui" {
					return TokenBody{}, &Error{Status: http.StatusBadRequest, Code: "invalid_scope",
						Message: `only a "ui" token can be issued`}
				}
				tok, err := t.issue(UI)
				return TokenBody{tok}, err
			}).
			WithStatus(http.StatusCreated).WithErrors("invalid_request", "invalid_scope"),
		Raw(http.MethodPost, "/shutdown", Shell, "shutdown", "Stop core", shutdownHandler(d.Shutdown)).
			WithStatus(http.StatusAccepted),
	)
}

// NewHandler serves every route behind the gate.
func NewHandler(d Deps) http.Handler {
	t := newTokens(d.Token)
	return gate(t, d.Port, d.Origins, newMux(routes(d, t), d.Logger))
}

// openapiHandler serves Document(d), built on the first request.
func openapiHandler(d Deps) http.HandlerFunc {
	var once sync.Once
	var doc []byte
	return func(w http.ResponseWriter, _ *http.Request) {
		once.Do(func() { doc = Document(d) })
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(doc)
	}
}

func shutdownHandler(shutdown func()) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "shutting_down"})
		// Only signal; the caller stops the server after this handler returns, so the 202 above still reaches the
		// client.
		shutdown()
	}
}

// modelList answers in the shape OpenAI clients (Open WebUI, OpenCode) expect.
func modelList(list func() ([]models.Model, error)) http.HandlerFunc {
	type entry struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		found, err := list()
		if err != nil {
			writeError(w, r, errModelsUnreadable)
			return
		}
		data := make([]entry, 0, len(found)) // [] rather than null when empty
		for _, m := range found {
			data = append(data, entry{ID: m.ID, Object: "model", OwnedBy: "openvatra"})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": data})
	}
}
