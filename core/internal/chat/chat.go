// Package chat runs a conversation turn: it saves the user's message, builds the prompt, streams the model's answer
// and saves it. It knows nothing about HTTP; the api package turns its events into Server-Sent Events.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/store"
)

// Errors a caller can turn into a plain HTTP status before any stream has started.
var (
	ErrNotFound = store.ErrNotFound
	ErrBadInput = errors.New("bad input")
)

// Event names of the stream (SPEC-chat.md, "Stream events").
const (
	EventStart     = "start"
	EventStatus    = "status"
	EventReasoning = "reasoning"
	EventDelta     = "delta"
	EventDone      = "done"
	EventError     = "error"
)

// Event is one thing that happened during a turn. Data is JSON-encodable.
type Event struct {
	Name string
	Data any
}

// Error codes sent in an `error` event. The messages are plain words for the user.
const (
	CodeModelNotFound  = "model_not_found"
	CodeModelLoad      = "model_load_failed"
	CodeContextTooBig  = "context_too_small"
	CodeBackendFailed  = "backend_failed"
	CodeNoEmbedding    = "no_embedding_model"
	fallbackContextTok = 16384 // used if the model's context size is unknown
)

// Service runs chat turns.
type Service struct {
	Store *store.Store
	Chat  provider.Chat
	// Model looks a model up; its Context is the size the prompt is fitted to (0 = unknown). Complete loads it.
	Model  func(ctx context.Context, id string) (provider.Model, error)
	Logger *slog.Logger
	// Now is the clock for the system prompt's date; nil means the real one.
	Now func() time.Time
}

// Input is what the user sends.
type Input struct {
	Text string
	// ReplaceLast removes the last user message and its answer first (editing the last message).
	ReplaceLast bool
}

// Stats is stored with the answer and sent in `done`.
type Stats struct {
	PromptTokens      int     `json:"promptTokens"`
	AnswerTokens      int     `json:"answerTokens"`
	TokensPerSecond   float64 `json:"tokensPerSecond"`
	ContextUsed       int     `json:"contextUsed"`
	ContextSize       int     `json:"contextSize"`
	FirstTokenMs      int64   `json:"firstTokenMs"`
	ReasoningMs       int64   `json:"reasoningMs,omitempty"`
	DroppedMessages   int     `json:"droppedMessages,omitempty"`
	FirstKeptID       string  `json:"firstKeptId,omitempty"`
	PromptTokensExact bool    `json:"promptTokensExact"`
}

func (s *Service) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Send saves the user's message and streams the answer to emit. Errors returned here happen before anything is
// saved or emitted (bad input, unknown chat); everything later is reported as an `error` event instead, because
// by then the stream is open.
func (s *Service) Send(ctx context.Context, chatID string, in Input, emit func(Event)) error {
	text := strings.TrimSpace(in.Text)
	if text == "" {
		return fmt.Errorf("%w: the message is empty", ErrBadInput)
	}
	c, err := s.Store.GetChat(ctx, chatID)
	if err != nil {
		return err
	}
	if c.Model == "" {
		return fmt.Errorf("%w: the chat has no model", ErrBadInput)
	}
	if in.ReplaceLast {
		if err := s.dropLastTurn(ctx, chatID, true); err != nil {
			return err
		}
	}
	user, err := s.Store.AddMessage(ctx, store.Message{ChatID: chatID, Role: store.RoleUser, Content: text})
	if err != nil {
		return err
	}
	s.run(ctx, c, user.ID, emit)
	return nil
}

// Regenerate replaces the last answer with a new one to the same question.
func (s *Service) Regenerate(ctx context.Context, chatID string, emit func(Event)) error {
	c, err := s.Store.GetChat(ctx, chatID)
	if err != nil {
		return err
	}
	if c.Model == "" {
		return fmt.Errorf("%w: the chat has no model", ErrBadInput)
	}
	if err := s.dropLastTurn(ctx, chatID, false); err != nil {
		return err
	}
	msgs, err := s.Store.Messages(ctx, chatID)
	if err != nil {
		return err
	}
	if len(msgs) == 0 || msgs[len(msgs)-1].Role != store.RoleUser {
		return fmt.Errorf("%w: nothing to answer", ErrBadInput)
	}
	s.run(ctx, c, msgs[len(msgs)-1].ID, emit)
	return nil
}

// dropLastTurn deletes the trailing answer and, when withQuestion is set, the user message before it.
func (s *Service) dropLastTurn(ctx context.Context, chatID string, withQuestion bool) error {
	msgs, err := s.Store.Messages(ctx, chatID)
	if err != nil {
		return err
	}
	if n := len(msgs); n > 0 && msgs[n-1].Role == store.RoleAssistant {
		if err := s.Store.DeleteMessage(ctx, msgs[n-1].ID); err != nil {
			return err
		}
		msgs = msgs[:n-1]
	}
	if n := len(msgs); withQuestion && n > 0 && msgs[n-1].Role == store.RoleUser {
		return s.Store.DeleteMessage(ctx, msgs[n-1].ID)
	}
	return nil
}

// turn is the state of one answer being written.
type turn struct {
	content, reasoning strings.Builder
	started            time.Time
	firstToken         time.Time // first reasoning or answer text
	reasoningDone      time.Time // first answer text
	usage              provider.Usage
}

// run answers the newest user message. It always saves the assistant message, whatever happens.
func (s *Service) run(ctx context.Context, c store.Chat, userID string, emit func(Event)) {
	assistant, err := s.Store.AddMessage(ctx, store.Message{
		ChatID: c.ID, Role: store.RoleAssistant, Model: c.Model, Status: store.StatusDone,
	})
	if err != nil {
		emit(Event{EventError, errData(CodeBackendFailed, "Could not save the answer.")})
		return
	}
	emit(Event{EventStart, map[string]string{"chatId": c.ID, "userMessageId": userID, "assistantMessageId": assistant.ID}})

	t := &turn{started: time.Now()}
	status, code, msg, stats := s.stream(ctx, c, t, emit)

	// The client may be gone (Stop): save anyway, on a context that outlives the request.
	save := context.WithoutCancel(ctx)
	statsJSON, _ := json.Marshal(stats)
	errText := ""
	if status == store.StatusError {
		errText = msg
	}
	if err := s.Store.UpdateMessage(save, assistant.ID, store.MessageUpdate{
		Content: t.content.String(), Reasoning: t.reasoning.String(), Status: status, Error: errText, Stats: statsJSON,
	}); err != nil {
		s.log().Error("save answer", "chat", c.ID, "err", err)
	}
	s.log().Info("answer finished", "chat", c.ID, "status", status, "answerChars", t.content.Len(),
		"promptTokens", stats.PromptTokens, "answerTokens", stats.AnswerTokens)

	if status == store.StatusError {
		emit(Event{EventError, errData(code, msg)})
		return
	}
	emit(Event{EventDone, map[string]any{"status": status, "messageId": assistant.ID, "stats": stats}})
}

func errData(code, message string) map[string]string {
	return map[string]string{"code": code, "message": message}
}

// stream gets the model, builds the prompt, and copies the answer into t. It returns the final status and, for
// errors, a code and message for the user.
func (s *Service) stream(ctx context.Context, c store.Chat, t *turn, emit func(Event)) (status, code, msg string, stats Stats) {
	emit(Event{EventStatus, "loading-model"})
	model, err := s.Model(ctx, c.Model)
	if err != nil {
		if ctx.Err() != nil {
			return store.StatusStopped, "", "", stats
		}
		code, msg := loadFailure(err)
		return store.StatusError, code, msg, stats
	}

	ctxSize := model.Context
	if ctxSize <= 0 {
		s.log().Warn("context size unknown, using a default", "model", c.Model)
		ctxSize = fallbackContextTok
	}
	stats.ContextSize = ctxSize

	history, err := s.Store.Messages(ctx, c.ID)
	if err != nil {
		return store.StatusError, CodeBackendFailed, "Could not read the conversation.", stats
	}
	// The assistant placeholder we just added is empty, and Build skips empty answers.
	system := prompt.SystemPrompt(s.now())

	for attempt := 0; ; attempt++ {
		built := prompt.Build(system, history, ctxSize, attempt*2)
		stats.PromptTokens, stats.DroppedMessages, stats.FirstKeptID = built.PromptTokens, built.Dropped, built.FirstKeptID
		msgs := make([]provider.Message, len(built.Messages))
		for i, m := range built.Messages {
			msgs[i] = provider.TextMessage(m.Role, m.Content)
		}
		res, err := s.Chat.Complete(ctx, provider.Request{Model: c.Model, Messages: msgs}, func(d provider.Delta) { t.add(d, emit) })
		t.usage = res.Usage
		var loadErr *provider.LoadError
		switch {
		case err == nil && res.Stop != provider.StopCancelled:
		case errors.Is(err, provider.ErrContextExceeded) && attempt == 0 && t.content.Len() == 0 && t.reasoning.Len() == 0:
			s.log().Info("context exceeded, retrying with fewer turns", "chat", c.ID)
			continue
		case errors.Is(err, provider.ErrContextExceeded):
			return store.StatusError, CodeContextTooBig, "This message is too long for this model.", s.finishStats(t, stats)
		case res.Stop == provider.StopCancelled || ctx.Err() != nil:
			return store.StatusStopped, "", "", s.finishStats(t, stats)
		case errors.Is(err, provider.ErrUnknownModel), errors.As(err, &loadErr):
			// Complete loads the model: it failed to load, or went away after Model looked it up.
			code, msg := loadFailure(err)
			return store.StatusError, code, msg, s.finishStats(t, stats)
		default:
			s.log().Warn("model stream failed", "chat", c.ID, "err", err)
			return store.StatusError, CodeBackendFailed, "The model stopped answering.", s.finishStats(t, stats)
		}
		break
	}
	if ctx.Err() != nil {
		return store.StatusStopped, "", "", s.finishStats(t, stats)
	}
	return store.StatusDone, "", "", s.finishStats(t, stats)
}

// loadFailure words a failure to ready the model for the user.
func loadFailure(err error) (code, msg string) {
	if errors.Is(err, provider.ErrUnknownModel) {
		return CodeModelNotFound, "That model is no longer in your models folder."
	}
	return CodeModelLoad, "The model could not be loaded: " + err.Error()
}

// add copies one delta of the answer into t and on to the user. Tool calls are not offered yet, so none are kept.
func (t *turn) add(d provider.Delta, emit func(Event)) {
	switch d.Kind {
	case provider.PartReasoning:
		if t.firstToken.IsZero() {
			t.firstToken = time.Now()
		}
		t.reasoning.WriteString(d.Text)
		emit(Event{EventReasoning, d.Text})
	case provider.PartText:
		now := time.Now()
		if t.firstToken.IsZero() {
			t.firstToken = now
		}
		if t.reasoning.Len() > 0 && t.reasoningDone.IsZero() {
			t.reasoningDone = now
		}
		t.content.WriteString(d.Text)
		emit(Event{EventDelta, d.Text})
	}
}

// finishStats fills the numbers the model reported, or our estimates where it reported none.
func (s *Service) finishStats(t *turn, st Stats) Stats {
	st.AnswerTokens = prompt.EstimateTokens(t.content.String() + t.reasoning.String())
	if t.usage.Exact {
		st.PromptTokens, st.AnswerTokens, st.PromptTokensExact = t.usage.PromptTokens, t.usage.AnswerTokens, true
	}
	st.ContextUsed = st.PromptTokens + st.AnswerTokens
	if !t.firstToken.IsZero() {
		st.FirstTokenMs = t.firstToken.Sub(t.started).Milliseconds()
		if !t.reasoningDone.IsZero() {
			st.ReasoningMs = t.reasoningDone.Sub(t.firstToken).Milliseconds()
		}
		if secs := time.Since(t.firstToken).Seconds(); secs > 0 {
			st.TokensPerSecond = float64(st.AnswerTokens) / secs
		}
	}
	if t.usage.TokensPerSecond > 0 {
		st.TokensPerSecond = t.usage.TokensPerSecond
	}
	return st
}

// Markdown renders a chat as a Markdown document for export. Reasoning is left out: it is not part of the answer.
func Markdown(c store.Chat, msgs []store.Message) string {
	var b strings.Builder
	title := c.Title
	if title == "" {
		title = "Chat"
	}
	b.WriteString("# " + title + "\n")
	for _, m := range msgs {
		who := "You"
		if m.Role == store.RoleAssistant {
			who = "Assistant"
		}
		b.WriteString("\n## " + who + "\n\n" + strings.TrimSpace(m.Content) + "\n")
		if m.Status == store.StatusStopped {
			b.WriteString("\n_(stopped)_\n")
		}
	}
	return b.String()
}
