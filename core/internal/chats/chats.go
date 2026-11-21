// Package chats is what clients do with chats: send to one (through the run engine), read, rename, re-model and
// delete them. It owns the "chat" config section, whose lastModel is the model a new chat starts on.
package chats

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/run"
	"github.com/countingticks/openvatra/core/internal/store"
)

// ID is the config section this package owns.
const ID = "chat"

// Settings is the "chat" config section.
type Settings struct {
	LastModel *string `json:"lastModel"` // the model the last chat made with an explicit model used; nil = none yet
}

func (s Settings) Validate() error {
	if s.LastModel != nil && *s.LastModel == "" {
		return errors.New("lastModel must not be empty; use null for none")
	}
	return nil
}

// DefaultSettings is the section before any chat names a model.
func DefaultSettings() Settings { return Settings{} }

var ErrNoChatModel = errors.New("no chat model is installed")

// Config is what a Service needs.
type Config struct {
	Store  *store.Store
	Engine *run.Engine
	Config *config.Store
	Models func(ctx context.Context) ([]provider.Model, error) // in the model list's order
	Logger *slog.Logger                                        // nil = discard
}

// SendInput is one send from a client; ChatID "" makes a new chat, Model "" keeps the chat's or picks the default.
type SendInput struct {
	RequestID, ChatID, Model, Text string
}

// Service is the chats API over the store, the engine and the config.
type Service struct {
	c   Config
	log *slog.Logger
}

// The engine checks these too; they are checked here first so a bad send never appends a chat.model.
const (
	maxInputRunes = 200_000
	maxTitleRunes = 200
)

func New(c Config) *Service {
	log := c.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Service{c: c, log: log}
}

// Send starts a run for the input, or adds it to the chat's active run.
func (s *Service) Send(ctx context.Context, in SendInput) (run.Ref, error) {
	if in.RequestID == "" || strings.TrimSpace(in.Text) == "" || utf8.RuneCountInString(in.Text) > maxInputRunes {
		return run.Ref{}, run.ErrBadInput
	}
	spec := run.Spec{ChatID: in.ChatID, Text: in.Text, RequestID: in.RequestID}
	if in.ChatID != "" {
		chat, _, err := s.c.Store.Chat(ctx, in.ChatID)
		if err != nil {
			return run.Ref{}, err
		}
		if in.Model != "" && in.Model != chat.Model {
			if err := s.checkModel(ctx, in.Model); err != nil {
				return run.Ref{}, err
			}
			if _, err := s.c.Store.Log().Append(ctx, "chat:"+chat.ID, event.ChatModel{Model: in.Model}); err != nil {
				return run.Ref{}, err
			}
		}
		return s.c.Engine.Start(ctx, spec)
	}

	model, err := s.newChatModel(ctx, in.Model)
	if err != nil {
		return run.Ref{}, err
	}
	spec.Model = model
	ref, err := s.c.Engine.Start(ctx, spec)
	if err == nil && in.Model != "" {
		s.rememberModel(in.Model)
	}
	return ref, err
}

// newChatModel is the model a new chat starts on: the one named, else lastModel, else the first chat model installed.
func (s *Service) newChatModel(ctx context.Context, named string) (string, error) {
	list, err := s.c.Models(ctx)
	if err != nil {
		return "", err
	}
	if named != "" {
		if !hasChatModel(list, named) {
			return "", provider.ErrUnknownModel
		}
		return named, nil
	}
	// A lastModel that was removed since falls through: the user did not name it this time.
	if last := config.Get[Settings](s.c.Config, ID).LastModel; last != nil && hasChatModel(list, *last) {
		return *last, nil
	}
	for _, m := range list {
		if m.Kind == provider.ModelChat {
			return m.ID, nil
		}
	}
	return "", ErrNoChatModel
}

// checkModel is provider.ErrUnknownModel unless id is an installed chat model.
func (s *Service) checkModel(ctx context.Context, id string) error {
	list, err := s.c.Models(ctx)
	if err != nil {
		return err
	}
	if !hasChatModel(list, id) {
		return provider.ErrUnknownModel
	}
	return nil
}

func hasChatModel(list []provider.Model, id string) bool {
	for _, m := range list {
		if m.ID == id && m.Kind == provider.ModelChat {
			return true
		}
	}
	return false
}

// rememberModel stores model as lastModel. A concurrent write may win the revision, so it reads again and retries
// once; after that it logs, since the chat itself was made and only the next default is affected.
func (s *Service) rememberModel(model string) {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		var entry config.SectionEntry
		if entry, err = s.c.Config.Section(ID); err != nil {
			break
		}
		var v Settings
		if err = json.Unmarshal(entry.Value, &v); err != nil {
			break
		}
		if v.LastModel != nil && *v.LastModel == model {
			return
		}
		v.LastModel = &model
		var value []byte
		if value, err = json.Marshal(v); err != nil {
			break
		}
		if _, err = s.c.Config.Put(ID, entry.Rev, value); !errors.Is(err, config.ErrConflict) {
			break
		}
	}
	if err != nil {
		s.log.Warn("could not remember the chat model", "model", model, "err", err)
	}
}

// List is every chat with a message, most recently updated first, and the log position it was read at.
func (s *Service) List(ctx context.Context) ([]store.ChatRow, int64, error) {
	return s.c.Store.Chats(ctx)
}

// Get is one chat, or store.ErrNotFound.
func (s *Service) Get(ctx context.Context, id string) (store.ChatRow, int64, error) {
	return s.c.Store.Chat(ctx, id)
}

// Transcript is a chat's messages and runs, oldest first, or store.ErrNotFound.
func (s *Service) Transcript(ctx context.Context, id string) ([]store.MessageRow, []store.RunRow, int64, error) {
	return s.c.Store.Transcript(ctx, id)
}

// Update renames the chat as the user and/or moves it to another installed chat model, and returns it after.
func (s *Service) Update(ctx context.Context, id string, title, model *string) (store.ChatRow, int64, error) {
	chat, seq, err := s.c.Store.Chat(ctx, id)
	if err != nil {
		return store.ChatRow{}, 0, err
	}
	var payloads []event.Payload
	if title != nil {
		t := strings.TrimSpace(*title)
		if t == "" || utf8.RuneCountInString(t) > maxTitleRunes {
			return store.ChatRow{}, 0, run.ErrBadInput
		}
		payloads = append(payloads, event.ChatTitled{Title: t, Source: "user"})
	}
	if model != nil {
		if err := s.checkModel(ctx, *model); err != nil {
			return store.ChatRow{}, 0, err
		}
		payloads = append(payloads, event.ChatModel{Model: *model})
	}
	if len(payloads) == 0 {
		return chat, seq, nil
	}
	if _, err := s.c.Store.Log().Append(ctx, "chat:"+id, payloads...); err != nil {
		return store.ChatRow{}, 0, err
	}
	return s.c.Store.Chat(ctx, id)
}

// Delete stops the chat's active run, waiting for it to end, then deletes the chat with its runs.
func (s *Service) Delete(ctx context.Context, id string) error {
	chat, _, err := s.c.Store.Chat(ctx, id)
	if err != nil {
		return err
	}
	if chat.ActiveRun != "" {
		if err := s.c.Engine.Stop(ctx, chat.ActiveRun); err != nil {
			return err
		}
	}
	return s.c.Store.DeleteChat(ctx, id)
}
