package chat

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/router"
	"github.com/countingticks/openvatra/core/internal/store"
)

type fakeRouter struct {
	base string
	err  error
}

func (f fakeRouter) Acquire(context.Context, router.Kind, string) (string, func(), error) {
	return f.base, func() {}, f.err
}

// upstream is a fake llama-server: /props plus a scripted /v1/chat/completions.
type upstream struct {
	mu       sync.Mutex
	requests []string
	handler  func(n int, w http.ResponseWriter, r *http.Request) // n = 0 for the first completion request
}

func (u *upstream) start(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/props" {
			fmt.Fprint(w, `{"default_generation_settings":{"n_ctx":8192}}`)
			return
		}
		u.mu.Lock()
		n := len(u.requests)
		u.requests = append(u.requests, r.URL.Path)
		u.mu.Unlock()
		u.handler(n, w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func sse(w http.ResponseWriter, lines ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, l := range lines {
		fmt.Fprintf(w, "data: %s\n\n", l)
	}
	w.(http.Flusher).Flush()
}

func newService(t *testing.T, up *upstream) (*Service, store.Chat) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c, err := st.CreateChat(context.Background(), "qwen", false)
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{
		Store: st, Router: fakeRouter{base: up.start(t)}, Sizes: &prompt.ContextSizes{},
		Now: func() time.Time { return time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC) },
	}
	return svc, c
}

type recorder struct{ events []Event }

func (r *recorder) emit(e Event) { r.events = append(r.events, e) }
func (r *recorder) names() string {
	var n []string
	for _, e := range r.events {
		n = append(n, e.Name)
	}
	return strings.Join(n, ",")
}
func (r *recorder) text(name string) string {
	var b strings.Builder
	for _, e := range r.events {
		if e.Name == name {
			b.WriteString(e.Data.(string))
		}
	}
	return b.String()
}

func lastAnswer(t *testing.T, svc *Service, chatID string) store.Message {
	t.Helper()
	msgs, _ := svc.Store.Messages(context.Background(), chatID)
	return msgs[len(msgs)-1]
}

func TestSendStreamsReasoningAnswerAndUsage(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w,
			`{"choices":[{"delta":{"reasoning_content":"hmm "}}]}`,
			`{"choices":[{"delta":{"reasoning_content":"ok"}}]}`,
			`{"choices":[{"delta":{"content":"Hel"}}]}`,
			`{"choices":[{"delta":{"content":"lo"}}]}`,
			`{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7},"timings":{"predicted_per_second":42.5}}`,
			`[DONE]`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	if err := svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit); err != nil {
		t.Fatal(err)
	}
	if got := rec.names(); !strings.HasPrefix(got, "start,status,reasoning") || !strings.HasSuffix(got, "delta,done") {
		t.Fatalf("events = %s", got)
	}
	if rec.text("reasoning") != "hmm ok" || rec.text("delta") != "Hello" {
		t.Fatalf("reasoning %q answer %q", rec.text("reasoning"), rec.text("delta"))
	}
	m := lastAnswer(t, svc, c.ID)
	if m.Content != "Hello" || m.Reasoning != "hmm ok" || m.Status != store.StatusDone || m.Model != "qwen" {
		t.Fatalf("saved %+v", m)
	}
	done := rec.events[len(rec.events)-1].Data.(map[string]any)["stats"].(Stats)
	if done.PromptTokens != 20 || done.AnswerTokens != 7 || done.TokensPerSecond != 42.5 || done.ContextSize != 8192 || !done.PromptTokensExact {
		t.Fatalf("stats %+v", done)
	}
	if !strings.Contains(string(m.Stats), `"answerTokens":7`) {
		t.Fatalf("stored stats %s", m.Stats)
	}
}

func TestSendPutsDateInSystemPromptAndLeavesReasoningOutOfHistory(t *testing.T) {
	var bodies []string
	up := &upstream{handler: func(_ int, w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 1<<16)
		n, _ := r.Body.Read(b)
		bodies = append(bodies, string(b[:n]))
		sse(w, `{"choices":[{"delta":{"reasoning_content":"SECRET"}}]}`, `{"choices":[{"delta":{"content":"a"}}]}`, `[DONE]`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "one"}, rec.emit)
	_ = svc.Send(context.Background(), c.ID, Input{Text: "two"}, rec.emit)
	if !strings.Contains(bodies[0], "Wednesday, 4 November 2026") || !strings.Contains(bodies[0], `"stream_options":{"include_usage":true}`) {
		t.Fatalf("first request: %s", bodies[0])
	}
	if strings.Contains(bodies[1], "SECRET") || !strings.Contains(bodies[1], "one") {
		t.Fatalf("second request must carry history without reasoning: %s", bodies[1])
	}
}

func TestErrorMidStreamKeepsPartialAnswer(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"par"}}]}`, `{"error":{"message":"boom","type":"server_error"}}`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	last := rec.events[len(rec.events)-1]
	if last.Name != EventError || last.Data.(map[string]string)["code"] != CodeBackendFailed {
		t.Fatalf("last event %+v", last)
	}
	m := lastAnswer(t, svc, c.ID)
	if m.Status != store.StatusError || m.Content != "par" || m.Error == "" {
		t.Fatalf("saved %+v", m)
	}
}

func TestContextExceededRetriesOnceWithFewerTurns(t *testing.T) {
	up := &upstream{handler: func(n int, w http.ResponseWriter, _ *http.Request) {
		if n < 2 { // earlier turns succeed
			sse(w, `{"choices":[{"delta":{"content":"ok"}}]}`, `[DONE]`)
			return
		}
		if n == 2 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"type":"exceed_context_size_error","message":"too long"}}`)
			return
		}
		sse(w, `{"choices":[{"delta":{"content":"fits"}}]}`, `[DONE]`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "one"}, rec.emit)
	_ = svc.Send(context.Background(), c.ID, Input{Text: "two"}, rec.emit)
	rec = recorder{}
	_ = svc.Send(context.Background(), c.ID, Input{Text: "three"}, rec.emit)
	m := lastAnswer(t, svc, c.ID)
	if m.Content != "fits" || m.Status != store.StatusDone || len(up.requests) != 4 {
		t.Fatalf("saved %+v after %d requests", m, len(up.requests))
	}
	if !strings.Contains(string(m.Stats), `"droppedMessages":2`) {
		t.Fatalf("cut point not recorded: %s", m.Stats)
	}
}

func TestContextExceededTwiceTellsTheUser(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"type":"exceed_context_size_error"}}`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	last := rec.events[len(rec.events)-1]
	if last.Name != EventError || last.Data.(map[string]string)["code"] != CodeContextTooBig {
		t.Fatalf("last event %+v", last)
	}
	if len(up.requests) != 2 {
		t.Fatalf("requests = %d, want exactly one retry", len(up.requests))
	}
}

func TestCancelSavesPartialAnswerAsStopped(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, r *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"half"}}]}`)
		<-r.Context().Done() // the model keeps "thinking" until we hang up
	}}
	svc, c := newService(t, up)
	ctx, cancel := context.WithCancel(context.Background())
	// Stop is pressed once the first text has reached the user.
	stopOnDelta := func(e Event) {
		if e.Name == EventDelta {
			cancel()
		}
	}
	if err := svc.Send(ctx, c.ID, Input{Text: "hi"}, stopOnDelta); err != nil {
		t.Fatal(err)
	}
	m := lastAnswer(t, svc, c.ID)
	if m.Status != store.StatusStopped || m.Content != "half" {
		t.Fatalf("saved %+v", m)
	}
}

func TestModelLoadFailureIsReportedAndSaved(t *testing.T) {
	up := &upstream{handler: func(int, http.ResponseWriter, *http.Request) {}}
	svc, c := newService(t, up)
	svc.Router = fakeRouter{err: router.ErrUnknownModel}
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	last := rec.events[len(rec.events)-1]
	if last.Name != EventError || last.Data.(map[string]string)["code"] != CodeModelNotFound {
		t.Fatalf("last event %+v", last)
	}
	if m := lastAnswer(t, svc, c.ID); m.Status != store.StatusError {
		t.Fatalf("saved %+v", m)
	}
}

func TestRegenerateReplacesTheLastAnswer(t *testing.T) {
	up := &upstream{handler: func(n int, w http.ResponseWriter, _ *http.Request) {
		sse(w, fmt.Sprintf(`{"choices":[{"delta":{"content":"answer %d"}}]}`, n), `[DONE]`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	_ = svc.Regenerate(context.Background(), c.ID, rec.emit)
	msgs, _ := svc.Store.Messages(context.Background(), c.ID)
	if len(msgs) != 2 || msgs[1].Content != "answer 1" {
		t.Fatalf("messages %+v", msgs)
	}
}

func TestReplaceLastSwapsQuestionAndAnswer(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"x"}}]}`, `[DONE]`)
	}}
	svc, c := newService(t, up)
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "typo"}, rec.emit)
	_ = svc.Send(context.Background(), c.ID, Input{Text: "fixed", ReplaceLast: true}, rec.emit)
	msgs, _ := svc.Store.Messages(context.Background(), c.ID)
	if len(msgs) != 2 || msgs[0].Content != "fixed" {
		t.Fatalf("messages %+v", msgs)
	}
}

func TestBadInputAndUnknownChat(t *testing.T) {
	up := &upstream{handler: func(int, http.ResponseWriter, *http.Request) {}}
	svc, c := newService(t, up)
	noop := func(Event) {}
	if err := svc.Send(context.Background(), c.ID, Input{Text: "  "}, noop); !errors.Is(err, ErrBadInput) {
		t.Fatalf("empty text: %v", err)
	}
	if err := svc.Send(context.Background(), "nope", Input{Text: "hi"}, noop); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}
	if err := svc.Regenerate(context.Background(), c.ID, noop); !errors.Is(err, ErrBadInput) {
		t.Fatalf("regenerate on empty chat: %v", err)
	}
}

func TestMarkdownExport(t *testing.T) {
	got := Markdown(store.Chat{Title: "Trip"}, []store.Message{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "hello", Reasoning: "private thoughts", Status: store.StatusStopped},
	})
	want := "# Trip\n\n## You\n\nhi\n\n## Assistant\n\nhello\n\n_(stopped)_\n"
	if got != want {
		t.Fatalf("got %q", got)
	}
}
