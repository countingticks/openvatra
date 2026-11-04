// Package chat runs a conversation turn: it saves the user's message, builds the prompt, streams the model's answer
// and saves it. It knows nothing about HTTP; the api package turns its events into Server-Sent Events.
package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/router"
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
	fallbackContextTok = 16384 // used if llama-server won't tell its context size
)

// Acquirer hands out a ready llama-server for a model. *router.Router satisfies it.
type Acquirer interface {
	Acquire(ctx context.Context, kind router.Kind, model string) (baseURL string, release func(), err error)
}

// Service runs chat turns.
type Service struct {
	Store  *store.Store
	Router Acquirer
	Sizes  *prompt.ContextSizes
	Logger *slog.Logger
	// Client talks to llama-server. It must have no overall timeout: an answer can take minutes.
	Client *http.Client
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
	usage              *usage
	timings            *timings
}

type usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

type timings struct {
	PredictedPerSecond float64 `json:"predicted_per_second"`
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
	base, release, err := s.Router.Acquire(ctx, router.Chat, c.Model)
	if err != nil {
		if ctx.Err() != nil {
			return store.StatusStopped, "", "", stats
		}
		switch {
		case errors.Is(err, router.ErrUnknownModel):
			return store.StatusError, CodeModelNotFound, "That model is no longer in your models folder.", stats
		default:
			return store.StatusError, CodeModelLoad, "The model could not be loaded: " + err.Error(), stats
		}
	}
	// Held until the answer is finished, so the model is never swapped out mid-answer.
	defer release()

	ctxSize, err := s.Sizes.Get(ctx, base)
	if err != nil {
		s.log().Warn("context size unknown, using a default", "err", err)
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
		err := s.call(ctx, base, c.Model, built.Messages, t, emit)
		switch {
		case err == nil:
		case errors.Is(err, errContextExceeded) && attempt == 0 && t.content.Len() == 0 && t.reasoning.Len() == 0:
			s.log().Info("context exceeded, retrying with fewer turns", "chat", c.ID)
			continue
		case errors.Is(err, errContextExceeded):
			return store.StatusError, CodeContextTooBig, "This message is too long for this model.", s.finishStats(t, stats)
		case ctx.Err() != nil:
			return store.StatusStopped, "", "", s.finishStats(t, stats)
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

// finishStats fills the numbers the model reported, or our estimates where it reported none.
func (s *Service) finishStats(t *turn, st Stats) Stats {
	st.AnswerTokens = prompt.EstimateTokens(t.content.String() + t.reasoning.String())
	if t.usage != nil {
		st.PromptTokens, st.AnswerTokens, st.PromptTokensExact = t.usage.PromptTokens, t.usage.CompletionTokens, true
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
	if t.timings != nil && t.timings.PredictedPerSecond > 0 {
		st.TokensPerSecond = t.timings.PredictedPerSecond
	}
	return st
}

var errContextExceeded = errors.New("context exceeded")

// call makes one streaming request to llama-server and forwards what it says.
func (s *Service) call(ctx context.Context, base, model string, msgs []prompt.Message, t *turn, emit func(Event)) error {
	body, _ := json.Marshal(map[string]any{
		"model": model, "messages": msgs, "stream": true,
		"stream_options": map[string]bool{"include_usage": true},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := s.Client
	if client == nil {
		client = &http.Client{}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if exceedsContext(b) {
			return errContextExceeded
		}
		return fmt.Errorf("model server answered %d", resp.StatusCode)
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		data, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue // blank separators and comments
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			return nil
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					Reasoning string `json:"reasoning_content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage   *usage   `json:"usage"`
			Timings *timings `json:"timings"`
			Error   *struct {
				Message string `json:"message"`
				Type    string `json:"type"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue // a malformed line is not worth losing the answer over
		}
		if chunk.Error != nil {
			if exceedsContext([]byte(chunk.Error.Type + " " + chunk.Error.Message)) {
				return errContextExceeded
			}
			return fmt.Errorf("model error: %s", chunk.Error.Message)
		}
		if chunk.Usage != nil {
			t.usage = chunk.Usage
		}
		if chunk.Timings != nil {
			t.timings = chunk.Timings
		}
		for _, ch := range chunk.Choices {
			if r := ch.Delta.Reasoning; r != "" {
				if t.firstToken.IsZero() {
					t.firstToken = time.Now()
				}
				t.reasoning.WriteString(r)
				emit(Event{EventReasoning, r})
			}
			if d := ch.Delta.Content; d != "" {
				now := time.Now()
				if t.firstToken.IsZero() {
					t.firstToken = now
				}
				if t.reasoning.Len() > 0 && t.reasoningDone.IsZero() {
					t.reasoningDone = now
				}
				t.content.WriteString(d)
				emit(Event{EventDelta, d})
			}
		}
	}
	// A cancelled request surfaces as a read error; the caller checks ctx to tell Stop from a failure.
	if err := sc.Err(); err != nil {
		return err
	}
	// The body ended without [DONE]: the server went away mid-answer.
	return errors.New("stream ended early")
}

// exceedsContext recognises llama-server's "prompt is longer than the context" reply.
func exceedsContext(b []byte) bool {
	s := strings.ToLower(string(b))
	return strings.Contains(s, "exceed_context_size") || strings.Contains(s, "exceeds the available context")
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
