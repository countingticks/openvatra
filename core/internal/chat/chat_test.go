package chat

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/store"
)

// call is one scripted answer of fakeProvider.
type call struct {
	deltas []provider.Delta
	res    provider.Result
	err    error
	hang   bool // after the deltas, wait for the request's context to end, then answer StopCancelled
}

// fakeProvider plays one scripted call per Complete (the last one repeats) and records each Request.
type fakeProvider struct {
	mu       sync.Mutex
	calls    []call
	requests []provider.Request
	modelErr error // what Model returns instead of the model
	context  int   // the Context Model reports
}

func (f *fakeProvider) Complete(ctx context.Context, req provider.Request, emit func(provider.Delta)) (provider.Result, error) {
	f.mu.Lock()
	n := len(f.requests)
	f.requests = append(f.requests, req)
	c := f.calls[min(n, len(f.calls)-1)]
	f.mu.Unlock()
	var parts []provider.Part
	for _, d := range c.deltas {
		emit(d)
		parts = provider.AppendDelta(parts, d)
	}
	if c.hang {
		<-ctx.Done()
		return provider.Result{Parts: parts, Stop: provider.StopCancelled}, nil
	}
	res := c.res
	res.Parts = parts
	return res, c.err
}

func (f *fakeProvider) model(_ context.Context, id string) (provider.Model, error) {
	if f.modelErr != nil {
		return provider.Model{}, f.modelErr
	}
	return provider.Model{ID: id, Kind: provider.ModelChat, Context: f.context}, nil
}

func (f *fakeProvider) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func text(s string) provider.Delta      { return provider.Delta{Kind: provider.PartText, Text: s} }
func reasoning(s string) provider.Delta { return provider.Delta{Kind: provider.PartReasoning, Text: s} }

func newService(t *testing.T, calls ...call) (*Service, store.Chat, *fakeProvider) {
	t.Helper()
	st, err := store.Open(t.TempDir(), event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c, err := st.CreateChat(context.Background(), "qwen", false)
	if err != nil {
		t.Fatal(err)
	}
	fp := &fakeProvider{calls: calls, context: 8192}
	svc := &Service{
		Store: st, Chat: fp, Model: fp.model,
		Now: func() time.Time { return time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC) },
	}
	return svc, c, fp
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
	svc, c, _ := newService(t, call{
		deltas: []provider.Delta{reasoning("hmm "), reasoning("ok"), text("Hel"), text("lo")},
		res:    provider.Result{Usage: provider.Usage{PromptTokens: 20, AnswerTokens: 7, Exact: true, TokensPerSecond: 42.5}},
	})
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

func TestSendWithoutUsageEstimatesCounts(t *testing.T) {
	svc, c, _ := newService(t, call{deltas: []provider.Delta{reasoning("thinking hard"), text("a fairly short answer")}})
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	done := rec.events[len(rec.events)-1].Data.(map[string]any)["stats"].(Stats)
	want := prompt.EstimateTokens("a fairly short answer" + "thinking hard")
	if done.PromptTokensExact || done.PromptTokens == 0 || done.AnswerTokens != want {
		t.Fatalf("stats %+v, want estimated counts (answer %d) and promptTokensExact false", done, want)
	}
}

func TestSendPutsDateInSystemPromptAndLeavesReasoningOutOfHistory(t *testing.T) {
	svc, c, fp := newService(t, call{deltas: []provider.Delta{reasoning("SECRET"), text("a")}})
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "one"}, rec.emit)
	_ = svc.Send(context.Background(), c.ID, Input{Text: "two"}, rec.emit)
	first, second := fp.requests[0], fp.requests[1]
	if first.Model != "qwen" || first.Messages[0].Role != "system" || !strings.Contains(first.Messages[0].Parts[0].Text, "Wednesday, 4 November 2026") {
		t.Fatalf("first request: %+v", first)
	}
	if first.MaxOut != 0 || len(first.Tools) != 0 || first.Sampling != (provider.Sampling{}) || first.CacheKey != "" {
		t.Fatalf("first request sets more than model and messages: %+v", first)
	}
	want := []provider.Message{
		first.Messages[0],
		provider.TextMessage("user", "one"),
		provider.TextMessage("assistant", "a"),
		provider.TextMessage("user", "two"),
	}
	if !reflect.DeepEqual(second.Messages, want) {
		t.Fatalf("second request must carry history without reasoning: %+v", second.Messages)
	}
}

func TestErrorMidStreamKeepsPartialAnswer(t *testing.T) {
	svc, c, _ := newService(t, call{deltas: []provider.Delta{text("par")}, err: errors.New("model error: boom")})
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
	ok := call{deltas: []provider.Delta{text("ok")}} // earlier turns succeed
	svc, c, fp := newService(t, ok, ok, call{err: provider.ErrContextExceeded}, call{deltas: []provider.Delta{text("fits")}})
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "one"}, rec.emit)
	_ = svc.Send(context.Background(), c.ID, Input{Text: "two"}, rec.emit)
	rec = recorder{}
	_ = svc.Send(context.Background(), c.ID, Input{Text: "three"}, rec.emit)
	m := lastAnswer(t, svc, c.ID)
	if m.Content != "fits" || m.Status != store.StatusDone || fp.count() != 4 {
		t.Fatalf("saved %+v after %d requests", m, fp.count())
	}
	if !strings.Contains(string(m.Stats), `"droppedMessages":2`) {
		t.Fatalf("cut point not recorded: %s", m.Stats)
	}
}

func TestContextExceededTwiceTellsTheUser(t *testing.T) {
	svc, c, fp := newService(t, call{err: provider.ErrContextExceeded})
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	last := rec.events[len(rec.events)-1]
	if last.Name != EventError || last.Data.(map[string]string)["code"] != CodeContextTooBig {
		t.Fatalf("last event %+v", last)
	}
	if fp.count() != 2 {
		t.Fatalf("requests = %d, want exactly one retry", fp.count())
	}
}

func TestCancelSavesPartialAnswerAsStopped(t *testing.T) {
	// The model keeps "thinking" until we hang up.
	svc, c, _ := newService(t, call{deltas: []provider.Delta{text("half")}, hang: true})
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
	tests := []struct {
		name      string
		err       error
		code      string
		inMessage string
	}{
		{"unknown model", provider.ErrUnknownModel, CodeModelNotFound, "no longer in your models folder"},
		{"failed load", &provider.LoadError{Model: "qwen", Err: errors.New("exited")}, CodeModelLoad, "load qwen: exited"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc, c, fp := newService(t, call{})
			fp.modelErr = tt.err
			var rec recorder
			_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
			last := rec.events[len(rec.events)-1]
			data := last.Data.(map[string]string)
			if last.Name != EventError || data["code"] != tt.code || !strings.Contains(data["message"], tt.inMessage) {
				t.Fatalf("last event %+v", last)
			}
			if m := lastAnswer(t, svc, c.ID); m.Status != store.StatusError {
				t.Fatalf("saved %+v", m)
			}
			if fp.count() != 0 {
				t.Fatalf("Complete called %d times after Model failed", fp.count())
			}
		})
	}
}

func TestCompleteOutcomes(t *testing.T) {
	t.Run("LoadError from Complete is model_load_failed", func(t *testing.T) {
		svc, c, _ := newService(t, call{err: &provider.LoadError{Model: "qwen", Err: errors.New("exited")}})
		var rec recorder
		_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
		last := rec.events[len(rec.events)-1]
		if last.Name != EventError || last.Data.(map[string]string)["code"] != CodeModelLoad {
			t.Fatalf("last event %+v", last)
		}
	})
	t.Run("StopLength is saved as done", func(t *testing.T) {
		svc, c, _ := newService(t, call{deltas: []provider.Delta{text("cut")}, res: provider.Result{Stop: provider.StopLength}})
		var rec recorder
		_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
		if m := lastAnswer(t, svc, c.ID); m.Status != store.StatusDone || m.Content != "cut" {
			t.Fatalf("saved %+v", m)
		}
	})
}

func TestUnknownContextSizeUsesTheDefault(t *testing.T) {
	svc, c, fp := newService(t, call{deltas: []provider.Delta{text("a")}})
	fp.context = 0
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	done := rec.events[len(rec.events)-1].Data.(map[string]any)["stats"].(Stats)
	if done.ContextSize != 16384 {
		t.Fatalf("context size %d, want 16384", done.ContextSize)
	}
}

func TestRegenerateReplacesTheLastAnswer(t *testing.T) {
	svc, c, _ := newService(t, call{deltas: []provider.Delta{text("answer 0")}}, call{deltas: []provider.Delta{text("answer 1")}})
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "hi"}, rec.emit)
	_ = svc.Regenerate(context.Background(), c.ID, rec.emit)
	msgs, _ := svc.Store.Messages(context.Background(), c.ID)
	if len(msgs) != 2 || msgs[1].Content != "answer 1" {
		t.Fatalf("messages %+v", msgs)
	}
}

func TestReplaceLastSwapsQuestionAndAnswer(t *testing.T) {
	svc, c, _ := newService(t, call{deltas: []provider.Delta{text("x")}})
	var rec recorder
	_ = svc.Send(context.Background(), c.ID, Input{Text: "typo"}, rec.emit)
	_ = svc.Send(context.Background(), c.ID, Input{Text: "fixed", ReplaceLast: true}, rec.emit)
	msgs, _ := svc.Store.Messages(context.Background(), c.ID)
	if len(msgs) != 2 || msgs[0].Content != "fixed" {
		t.Fatalf("messages %+v", msgs)
	}
}

func TestBadInputAndUnknownChat(t *testing.T) {
	svc, c, _ := newService(t, call{})
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
