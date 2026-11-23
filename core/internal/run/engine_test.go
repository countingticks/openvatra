package run

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/budget"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/profile"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/provider/providertest"
	"github.com/countingticks/openvatra/core/internal/sched"
	"github.com/countingticks/openvatra/core/internal/store"
)

var update = flag.Bool("update", false, "rewrite testdata/*.jsonl")

var bg = context.Background()

// clock is the fixed time the system prompt's date comes from.
var clock = time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)

const contextSize = 8192

// gated is the scripted model with some calls held at the door until the test lets them in: a model that is slow
// to start answering. Entered receives each call's number (from 1) as it arrives.
type gated struct {
	*providertest.Scripted
	mu      sync.Mutex
	calls   int
	hold    map[int]chan struct{}
	entered chan int
}

func (g *gated) Complete(ctx context.Context, req provider.Request, emit func(provider.Delta)) (provider.Result, error) {
	g.mu.Lock()
	g.calls++
	n, gate := g.calls, g.hold[g.calls]
	g.mu.Unlock()
	g.entered <- n
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
		}
	}
	return g.Scripted.Complete(ctx, req, emit)
}

// holdCall makes call n wait until the returned func is called.
func (g *gated) holdCall(n int) func() {
	ch := make(chan struct{})
	g.mu.Lock()
	g.hold[n] = ch
	g.mu.Unlock()
	return func() { close(ch) }
}

// counter is a fake provider.Counter: it records each text it counts and answers with the estimate, or err.
type counter struct {
	mu    sync.Mutex
	texts []string
	err   error
}

func (c *counter) Count(_ context.Context, _ string, text string) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.texts = append(c.texts, text)
	if c.err != nil {
		return 0, c.err
	}
	return budget.EstimateTokens(text), nil
}

func (c *counter) calls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.texts)
}

type fixture struct {
	t         *testing.T
	store     *store.Store
	bus       *event.Bus
	model     *gated
	sched     *sched.FIFO
	modelErrs map[string]error
	size      int // the context size the model reports, read at each call
	counter   *counter
	reqN      int // request ids say has used
	eng       *Engine
	events    <-chan event.Event
	seen      []event.Event // every event waitFor has read, in order
	step      time.Duration // when set, each call of the engine's clock moves it forward by this much
	clockMu   sync.Mutex
	ticks     time.Duration
	profiles  *profile.Registry // the engine's profiles: noTitles unless a test wants titles
}

// newFixture is an engine over a real store in a temporary folder, answering with turns.
func newFixture(t *testing.T, turns ...providertest.Turn) *fixture {
	t.Helper()
	bus := event.NewBus(4096)
	st, err := store.Open(t.TempDir(), bus)
	if err != nil {
		t.Fatal(err)
	}
	_, events, cancel := bus.Subscribe(event.Filter{})
	f := &fixture{t: t, store: st, bus: bus, events: events, modelErrs: map[string]error{}, size: contextSize,
		counter: &counter{}, profiles: noTitles()}
	f.eng = f.newEngine(turns...)
	t.Cleanup(func() {
		f.eng.Close()
		cancel()
		st.Close()
	})
	return f
}

// newEngine replaces the fixture's engine and model with new ones on the same store, as a restarted core would.
func (f *fixture) newEngine(turns ...providertest.Turn) *Engine {
	f.model = &gated{Scripted: providertest.NewScripted(turns...), hold: map[int]chan struct{}{}, entered: make(chan int, 64)}
	f.sched = sched.NewFIFO(nil)
	f.eng = New(Config{
		Log:   f.store.Log(),
		Views: f.store,
		Chat:  f.model,
		Model: func(_ context.Context, id string) (provider.Model, error) {
			if err := f.modelErrs[id]; err != nil {
				return provider.Model{}, err
			}
			return provider.Model{ID: id, Kind: provider.ModelChat, Context: f.size}, nil
		},
		Sched:    f.sched,
		Profiles: f.profiles,
		Counter:  f.counter,
		Now: func() time.Time {
			f.clockMu.Lock()
			defer f.clockMu.Unlock()
			t := clock.Add(f.ticks)
			f.ticks += f.step
			return t
		},
	})
	return f.eng
}

// noTitles is the built-in profiles with chat titles off, so a scripted turn is never spent on a title.
func noTitles() *profile.Registry {
	chat, _ := profile.Builtin().Get("chat")
	chat.Title = false
	return profile.Builtin().With(chat)
}

// newTitleFixture is newFixture with the built-in profiles: a chat's first run asks for a title.
func newTitleFixture(t *testing.T, turns ...providertest.Turn) *fixture {
	t.Helper()
	f := newFixture(t)
	f.profiles = profile.Builtin()
	f.newEngine(turns...)
	return f
}

func (f *fixture) start(s Spec) Ref {
	f.t.Helper()
	ref, err := f.eng.Start(bg, s)
	if err != nil {
		f.t.Fatalf("Start(%+v): %v", s, err)
	}
	return ref
}

// send starts a new chat on model m1.
func (f *fixture) send(text, requestID string) Ref {
	f.t.Helper()
	return f.start(Spec{Model: "m1", Text: text, RequestID: requestID})
}

// waitFor reads published events until one of type typ on runID's stream (any stream when "") arrives, for at
// most 5 s.
func (f *fixture) waitFor(typ, runID string) event.Event {
	f.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e, ok := <-f.events:
			if !ok {
				f.t.Fatal("event subscription fell behind")
			}
			f.seen = append(f.seen, e)
			if e.Type == typ && (runID == "" || e.Stream == "run:"+runID) {
				return e
			}
		case <-deadline:
			f.t.Fatalf("no %s for run %q within 5 s", typ, runID)
		}
	}
}

func (f *fixture) finished(runID string) event.RunFinished {
	f.t.Helper()
	return decodeAs[event.RunFinished](f.t, f.waitFor("run.finished", runID))
}

func (f *fixture) entered() int {
	f.t.Helper()
	select {
	case n := <-f.model.entered:
		return n
	case <-time.After(5 * time.Second):
		f.t.Fatal("the model was not asked")
		return 0
	}
}

func decodeAs[T any](t *testing.T, e event.Event) T {
	t.Helper()
	var p T
	if err := json.Unmarshal(e.Data, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// stored is every durable event in the log, oldest first.
func (f *fixture) stored() []event.Event {
	f.t.Helper()
	events, err := f.store.Log().Read(bg, 0, event.Filter{}, 1000)
	if err != nil {
		f.t.Fatal(err)
	}
	return events
}

func (f *fixture) storedOf(typ string) []event.Event {
	var out []event.Event
	for _, e := range f.stored() {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func (f *fixture) runState(runID string) string {
	f.t.Helper()
	row, _, err := f.store.Run(bg, runID)
	if err != nil {
		f.t.Fatal(err)
	}
	return row.State
}

// prompt is the role and text of each message of request i (from 0) after the system prompt.
func (f *fixture) prompt(i int) []string {
	f.t.Helper()
	reqs := f.model.Requests()
	if i >= len(reqs) {
		f.t.Fatalf("only %d requests", len(reqs))
	}
	var out []string
	for _, m := range reqs[i].Messages[1:] {
		out = append(out, m.Role+":"+m.Parts[0].Text)
	}
	return out
}

// golden is one line of testdata/<name>.jsonl: an event with its ids replaced by stable names.
type golden struct {
	Type   string          `json:"type"`
	Stream string          `json:"stream"`
	Data   json.RawMessage `json:"data"`
}

// checkLog writes the log to testdata/<name>.jsonl with -update, and otherwise compares the event types, streams
// and states against it.
func (f *fixture) checkLog(name string) {
	f.t.Helper()
	names := map[string]string{}
	counts := map[string]int{}
	rename := func(kind, id string) string {
		if _, ok := names[id]; !ok {
			counts[kind]++
			names[id] = fmt.Sprintf("%s%d", kind, counts[kind])
		}
		return names[id]
	}
	var got []golden
	for _, e := range f.stored() {
		kind, id, _ := strings.Cut(e.Stream, ":")
		stream := kind + ":" + rename(kind, id)
		data := string(e.Data)
		for real, stable := range names {
			data = strings.ReplaceAll(data, real, stable)
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(data), &m); err != nil {
			f.t.Fatal(err)
		}
		if stats, ok := m["stats"].(map[string]any); ok {
			stats["durationMs"] = 0 // the only field that changes between runs
		}
		raw, _ := json.Marshal(m)
		got = append(got, golden{Type: e.Type, Stream: stream, Data: raw})
	}

	path := filepath.Join("testdata", name+".jsonl")
	if *update {
		var b strings.Builder
		for _, g := range got {
			line, _ := json.Marshal(g)
			b.Write(line)
			b.WriteByte('\n')
		}
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			f.t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			f.t.Fatal(err)
		}
		return
	}
	file, err := os.Open(path)
	if err != nil {
		f.t.Fatalf("%v; run go -C core test ./internal/run -update", err)
	}
	defer file.Close()
	var want []golden
	sc := bufio.NewScanner(file)
	for sc.Scan() {
		var g golden
		if err := json.Unmarshal(sc.Bytes(), &g); err != nil {
			f.t.Fatal(err)
		}
		want = append(want, g)
	}
	summary := func(gs []golden) []string {
		var out []string
		for _, g := range gs {
			var p struct {
				State string          `json:"state"`
				Error *event.RunError `json:"error"`
			}
			json.Unmarshal(g.Data, &p)
			line := g.Stream + " " + g.Type + " " + p.State
			if p.Error != nil {
				line += " " + p.Error.Code
			}
			out = append(out, strings.TrimSpace(line))
		}
		return out
	}
	if g, w := summary(got), summary(want); !slices.Equal(g, w) {
		f.t.Fatalf("log differs from %s:\ngot\n%s\nwant\n%s", path, strings.Join(g, "\n"), strings.Join(w, "\n"))
	}
}

func TestStart(t *testing.T) {
	t.Run("send → started, deltas numbered from 1, completed with stats, finished done", func(t *testing.T) {
		usage := provider.Usage{PromptTokens: 40, AnswerTokens: 3, Exact: true, TokensPerSecond: 12.5, FirstTokenMs: 30}
		f := newFixture(t, providertest.Turn{Reasoning: []string{"think"}, Text: []string{"Hel", "lo"}, Usage: usage})
		ref := f.send("hi", "req-1")
		if fin := f.finished(ref.RunID); fin.State != "done" || fin.Error != nil {
			t.Fatalf("finished %+v", fin)
		}
		var ns []int
		var completed event.MessageCompleted
		for _, e := range f.seen {
			switch e.Type {
			case "reasoning.delta":
				ns = append(ns, decodeAs[event.ReasoningDelta](t, e).N)
			case "message.delta":
				ns = append(ns, decodeAs[event.MessageDelta](t, e).N)
			case "message.completed":
				completed = decodeAs[event.MessageCompleted](t, e)
			}
		}
		if !slices.Equal(ns, []int{1, 2, 3}) {
			t.Fatalf("delta numbers %v", ns)
		}
		wantParts := []event.MessagePart{{Kind: "reasoning", Text: "think"}, {Kind: "text", Text: "Hello"}}
		s := completed.Stats
		if !slices.Equal(completed.Parts, wantParts) || completed.Partial || completed.Model != "m1" ||
			s.PromptTokens != 40 || s.AnswerTokens != 3 || !s.Exact || s.TokensPerSecond != 12.5 ||
			s.FirstTokenMs != 30 || s.ContextSize != contextSize {
			t.Fatalf("completed %+v", completed)
		}
		reqs := f.model.Requests()
		if len(reqs) != 1 || reqs[0].Model != "m1" ||
			!strings.Contains(reqs[0].Messages[0].Parts[0].Text, "Today is Saturday, 21 November 2026.") {
			t.Fatalf("requests %+v", reqs)
		}
		if got := f.prompt(0); !slices.Equal(got, []string{"user:hi"}) {
			t.Fatalf("prompt %v", got)
		}
		if ref.Seq != f.storedOf("input.received")[0].Seq {
			t.Fatalf("Ref.Seq %d is not the input's seq", ref.Seq)
		}
		f.checkLog("send_done")
	})

	t.Run("Start rejects bad input and an unknown chat", func(t *testing.T) {
		f := newFixture(t)
		cases := []struct {
			name string
			spec Spec
			want error
		}{
			{"empty request id", Spec{Model: "m1", Text: "hi"}, ErrBadInput},
			{"empty text", Spec{Model: "m1", RequestID: "r"}, ErrBadInput},
			{"all-space text", Spec{Model: "m1", Text: " \n\t ", RequestID: "r"}, ErrBadInput},
			{"text of 200,001 runes", Spec{Model: "m1", Text: strings.Repeat("ă", 200_001), RequestID: "r"}, ErrBadInput},
			{"new chat without a model", Spec{Text: "hi", RequestID: "r"}, ErrBadInput},
			{"unknown profile", Spec{Model: "m1", Text: "hi", RequestID: "r", Profile: "nope"}, ErrBadInput},
			{"unknown chat", Spec{ChatID: "missing", Text: "hi", RequestID: "r"}, store.ErrNotFound},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				if _, err := f.eng.Start(bg, tc.spec); !errors.Is(err, tc.want) {
					t.Fatalf("err = %v, want %v", err, tc.want)
				}
				if n := len(f.stored()); n != 0 {
					t.Fatalf("%d events appended", n)
				}
			})
		}
	})

	t.Run("the same request id twice returns the first run and writes nothing", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}})
		first := f.send("hi", "req-1")
		f.finished(first.RunID)
		before := len(f.stored())
		again := f.send("hi", "req-1")
		row, _, err := f.store.Run(bg, first.RunID)
		if err != nil {
			t.Fatal(err)
		}
		if again.RunID != first.RunID || again.ChatID != first.ChatID || again.Seq != row.LastSeq {
			t.Fatalf("again = %+v, first = %+v, last seq %d", again, first, row.LastSeq)
		}
		if after := len(f.stored()); after != before {
			t.Fatalf("%d events before, %d after", before, after)
		}
	})

	t.Run("a message sent mid-answer is queued and answered by the same run", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"one!"}}, providertest.Turn{Text: []string{"two!"}})
		release := f.model.holdCall(1)
		ref := f.send("one", "req-1")
		f.entered()
		second := f.start(Spec{ChatID: ref.ChatID, Text: "two", RequestID: "req-2"})
		if second.RunID != ref.RunID {
			t.Fatalf("second input went to run %s, not %s", second.RunID, ref.RunID)
		}
		release()
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if got := f.prompt(1); !slices.Equal(got, []string{"user:one", "assistant:one!", "user:two"}) {
			t.Fatalf("second prompt %v", got)
		}
		f.checkLog("queued_input")
	})

	t.Run("two Starts on one chat at once make one run", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}}, providertest.Turn{Text: []string{"b"}},
			providertest.Turn{Text: []string{"c"}})
		first := f.send("hi", "req-1")
		f.finished(first.RunID)
		release := f.model.holdCall(2)
		refs := make(chan Ref, 2)
		for _, req := range []string{"req-2", "req-3"} {
			go func() {
				ref, err := f.eng.Start(bg, Spec{ChatID: first.ChatID, Text: req, RequestID: req})
				if err != nil {
					t.Error(err)
				}
				refs <- ref
			}()
		}
		a, b := <-refs, <-refs
		release()
		if a.RunID != b.RunID || a.RunID == first.RunID {
			t.Fatalf("runs %s and %s", a.RunID, b.RunID)
		}
		f.finished(a.RunID)
		if n := len(f.storedOf("run.queued")); n != 2 {
			t.Fatalf("%d runs queued, want 2", n)
		}
	})
}

func TestReasoningMs(t *testing.T) {
	reasoningMs := func(f *fixture) []int64 {
		var out []int64
		for _, e := range f.storedOf("message.completed") {
			out = append(out, decodeAs[event.MessageCompleted](t, e).Stats.ReasoningMs)
		}
		return out
	}

	t.Run("an answer with reasoning then text says how long the model thought", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Reasoning: []string{"a", "b"}, Text: []string{"x"}})
		f.step = time.Millisecond
		f.finished(f.send("hi", "req-1").RunID)
		if got := reasoningMs(f); len(got) != 1 || got[0] <= 0 {
			t.Fatalf("reasoningMs %v", got)
		}
	})

	t.Run("an answer with text only has no thinking time", func(t *testing.T) {
		f := newFixture(t, answer("x"))
		f.step = time.Millisecond
		f.finished(f.send("hi", "req-1").RunID)
		if got := reasoningMs(f); !slices.Equal(got, []int64{0}) {
			t.Fatalf("reasoningMs %v", got)
		}
	})

	t.Run("the second answer of a run measures its own reasoning", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Reasoning: []string{"a", "b"}, Text: []string{"one"}}, answer("two"))
		f.step = time.Millisecond
		release := f.model.holdCall(1)
		ref := f.send("one", "req-1")
		f.entered()
		f.start(Spec{ChatID: ref.ChatID, Text: "two", RequestID: "req-2"})
		release()
		f.finished(ref.RunID)
		if got := reasoningMs(f); len(got) != 2 || got[0] <= 0 || got[1] != 0 {
			t.Fatalf("reasoningMs %v", got)
		}
	})

	t.Run("a stop after some text keeps the thinking time on the partial answer", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Reasoning: []string{"a"}, Text: []string{"par"}, Hang: true})
		f.step = time.Millisecond
		ref := f.send("hi", "req-1")
		f.waitFor("message.delta", ref.RunID)
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if got := reasoningMs(f); len(got) != 1 || got[0] <= 0 {
			t.Fatalf("reasoningMs %v", got)
		}
	})

	t.Run("a stop during reasoning keeps no answer", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Reasoning: []string{"a"}, Hang: true})
		ref := f.send("hi", "req-1")
		f.waitFor("reasoning.delta", ref.RunID)
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if got := reasoningMs(f); len(got) != 0 {
			t.Fatalf("reasoningMs %v", got)
		}
	})
}

func TestStop(t *testing.T) {
	t.Run("stop mid-answer keeps the partial answer and finishes stopped", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"par", "tial"}, Hang: true})
		ref := f.send("hi", "req-1")
		f.waitFor("message.delta", ref.RunID)
		f.waitFor("message.delta", ref.RunID)
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		completed := f.storedOf("message.completed")
		if len(completed) != 1 {
			t.Fatalf("%d answers stored", len(completed))
		}
		if p := decodeAs[event.MessageCompleted](t, completed[0]); !p.Partial || textOf(p.Parts) != "partial" {
			t.Fatalf("answer %+v", p)
		}
		if s := f.runState(ref.RunID); s != "stopped" {
			t.Fatalf("state %s", s)
		}
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatalf("stopping a finished run: %v", err)
		}
		if err := f.eng.Stop(bg, "missing"); !errors.Is(err, ErrRunNotFound) {
			t.Fatalf("stopping an unknown run: %v", err)
		}
		f.checkLog("stop_partial")
	})

	t.Run("stop while waiting for the lease finishes stopped without asking the model", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"x"}, Hang: true})
		a := f.send("first", "req-1")
		f.waitFor("message.delta", a.RunID)
		b := f.send("second", "req-2")
		waitUntil(t, func() bool { s := f.sched.State(); return len(s.Waiting) == 1 && s.Waiting[0].RunID == b.RunID })
		if err := f.eng.Stop(bg, b.RunID); err != nil {
			t.Fatal(err)
		}
		if s := f.runState(b.RunID); s != "stopped" {
			t.Fatalf("state %s", s)
		}
		if n := len(f.model.Requests()); n != 1 {
			t.Fatalf("the model was asked %d times", n)
		}
		if err := f.eng.Stop(bg, a.RunID); err != nil {
			t.Fatal(err)
		}
	})
}

func TestFailures(t *testing.T) {
	t.Run("a provider error mid-answer keeps the partial text, marks it failed and finishes failed with backend_failed", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"half"}, Err: errors.New("connection reset")})
		ref := f.send("hi", "req-1")
		fin := f.finished(ref.RunID)
		if fin.State != "failed" || fin.Error == nil || fin.Error.Code != "backend_failed" ||
			fin.Error.Message != "The model stopped answering." {
			t.Fatalf("finished %+v", fin)
		}
		msgs, _, _, err := f.store.Transcript(bg, ref.ChatID)
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) != 2 || !msgs[1].Partial || !msgs[1].Failed || !strings.Contains(string(msgs[1].Parts), "half") {
			t.Fatalf("messages %+v", msgs)
		}
		f.checkLog("fail_midway")
	})

	t.Run("an overflow with no older turns fails with context_exceeded", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Err: provider.ErrContextExceeded})
		ref := f.send("q1", "req-1")
		fin := f.finished(ref.RunID)
		if fin.State != "failed" || fin.Error == nil || fin.Error.Code != "context_exceeded" ||
			fin.Error.Message != "This chat is too long for this model, even after summarising." {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.model.Requests()); n != 1 {
			t.Fatalf("%d requests, want 1", n)
		}
	})

	t.Run("an unknown model fails with model_not_found; a load error with model_load_failed", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Err: &provider.LoadError{Model: "m1", Err: errors.New("exit status 1")}})
		f.modelErrs["gone"] = fmt.Errorf("lookup: %w", provider.ErrUnknownModel)
		gone := f.start(Spec{Model: "gone", Text: "hi", RequestID: "req-1"})
		if fin := f.finished(gone.RunID); fin.Error == nil || fin.Error.Code != "model_not_found" ||
			fin.Error.Message != "This model is no longer in the models folder." {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.model.Requests()); n != 0 {
			t.Fatalf("the model was asked %d times", n)
		}
		broken := f.send("hi", "req-2")
		if fin := f.finished(broken.RunID); fin.Error == nil || fin.Error.Code != "model_load_failed" ||
			fin.Error.Message != "The model failed to load. Check its settings." {
			t.Fatalf("finished %+v", fin)
		}
	})
}

func TestBudget(t *testing.T) {
	chatPrompt := func(t *testing.T) string {
		p, ok := profile.Builtin().Get("chat")
		if !ok {
			t.Fatal("no chat profile")
		}
		return p.SystemPrompt(clock)
	}

	t.Run("the first request's system message is the chat prompt and its cache key is the chat id", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}})
		ref := f.send("hi", "req-1")
		f.finished(ref.RunID)
		req := f.model.Requests()[0]
		if req.Messages[0].Role != "system" || req.Messages[0].Parts[0].Text != chatPrompt(t) || req.CacheKey != ref.ChatID {
			t.Fatalf("request %+v", req)
		}
	})

	t.Run("a run with a queued second input counts the fixed part once", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"one!"}}, providertest.Turn{Text: []string{"two!"}})
		release := f.model.holdCall(1)
		ref := f.send("one", "req-1")
		f.entered()
		f.start(Spec{ChatID: ref.ChatID, Text: "two", RequestID: "req-2"})
		release()
		f.finished(ref.RunID)
		if n := len(f.model.Requests()); n != 2 {
			t.Fatalf("%d requests, want 2", n)
		}
		if n := f.counter.calls(); n != 1 {
			t.Fatalf("counted %d times, want 1", n)
		}
		if f.counter.texts[0] != chatPrompt(t) {
			t.Fatalf("counted %q", f.counter.texts[0])
		}
	})

	t.Run("a Count error still answers with the estimate", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}})
		f.counter.err = errors.New("no tokenizer")
		ref := f.send("hi", "req-1")
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
	})

	t.Run("a fixed part over half of Room fails context_too_small without asking the model", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}})
		f.size = 64 // Room 48: the chat prompt's ~38 tokens are over half
		ref := f.send("hi", "req-1")
		fin := f.finished(ref.RunID)
		if fin.State != "failed" || fin.Error == nil || fin.Error.Code != "context_too_small" ||
			fin.Error.Message != "This model's context is too small to chat. Pick a larger context in model settings." {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.model.Requests()); n != 0 {
			t.Fatalf("the model was asked %d times", n)
		}
	})

	t.Run("an input over Room minus the fixed part fails message_too_long", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}})
		ref := f.send(strings.Repeat("w", 25_000), "req-1") // ~7,143 tokens; Room is 6,144
		fin := f.finished(ref.RunID)
		if fin.State != "failed" || fin.Error == nil || fin.Error.Code != "message_too_long" ||
			fin.Error.Message != "This message is too long for this model." {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.model.Requests()); n != 0 {
			t.Fatalf("the model was asked %d times", n)
		}
	})

	t.Run("a summary is in the system message and the turns before its first kept message are not sent", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a1"}}, providertest.Turn{Text: []string{"a2"}},
			providertest.Turn{Text: []string{"a3"}})
		first := f.send("q1", "req-1")
		f.finished(first.RunID)
		second := f.start(Spec{ChatID: first.ChatID, Text: "q2", RequestID: "req-2"})
		f.finished(second.RunID)
		kept := f.storedOf("input.received")[1].Seq
		if _, err := f.store.Log().Append(bg, "run:"+second.RunID, event.CompactionCompleted{
			ChatID: first.ChatID, Summary: "They said q1.", FirstKeptSeq: kept, TokensBefore: 100, TokensAfter: 50,
		}); err != nil {
			t.Fatal(err)
		}
		third := f.start(Spec{ChatID: first.ChatID, Text: "q3", RequestID: "req-3"})
		f.finished(third.RunID)
		req := f.model.Requests()[2]
		if want := chatPrompt(t) + "\n\nSummary of the earlier conversation:\nThey said q1."; req.Messages[0].Parts[0].Text != want {
			t.Fatalf("system %q", req.Messages[0].Parts[0].Text)
		}
		if got := f.prompt(2); !slices.Equal(got, []string{"user:q2", "assistant:a2", "user:q3"}) {
			t.Fatalf("prompt %v", got)
		}
	})
}

func TestContextUse(t *testing.T) {
	t.Run("after an exact answer, used is its prompt tokens plus the answer's estimate; nothing is counted", func(t *testing.T) {
		usage := provider.Usage{PromptTokens: 40, AnswerTokens: 3, Exact: true}
		f := newFixture(t, providertest.Turn{Text: []string{"Hello there"}, Usage: usage})
		ref, _ := f.say("", "hi")
		calls := f.counter.calls()
		use, err := f.eng.ContextUse(bg, ref.ChatID)
		if err != nil {
			t.Fatal(err)
		}
		used, size := use.Used, use.Size
		if want := 40 + budget.EstimateTokens("Hello there") + perMessageTokens; used != want || size != contextSize {
			t.Fatalf("used %d, size %d; want %d, %d", used, size, want, contextSize)
		}
		if use.Parts.MessageCount != 2 || use.Parts.System+use.Parts.Messages != used {
			t.Fatalf("parts = %+v, used %d", use.Parts, used)
		}
		if f.counter.calls() != calls {
			t.Fatal("ContextUse called the counter")
		}
	})

	t.Run("a model no longer installed gives size 0", func(t *testing.T) {
		f := newFixture(t, answer("a"))
		ref, _ := f.say("", "hi")
		f.modelErrs["m1"] = provider.ErrUnknownModel
		use, err := f.eng.ContextUse(bg, ref.ChatID)
		if err != nil || use.Size != 0 || use.Used == 0 {
			t.Fatalf("use %+v, err %v", use, err)
		}
	})
}

func TestPrompt(t *testing.T) {
	t.Run("the prompt leaves out reasoning, failed answers and the inputs queued behind the one being answered", func(t *testing.T) {
		f := newFixture(t,
			providertest.Turn{Text: []string{"bad"}, Err: errors.New("boom")},
			providertest.Turn{Reasoning: []string{"secret"}, Text: []string{"ans1"}},
			providertest.Turn{Text: []string{"ans2"}},
			providertest.Turn{Text: []string{"ans3"}},
		)
		failed := f.send("q0", "req-0")
		f.finished(failed.RunID)
		release := f.model.holdCall(2)
		ref := f.start(Spec{ChatID: failed.ChatID, Text: "one", RequestID: "req-1"})
		f.entered()
		f.entered()
		f.start(Spec{ChatID: failed.ChatID, Text: "two", RequestID: "req-2"})
		f.start(Spec{ChatID: failed.ChatID, Text: "three", RequestID: "req-3"})
		release()
		f.finished(ref.RunID)
		want := []string{"user:q0", "user:one", "assistant:ans1", "user:two"}
		if got := f.prompt(2); !slices.Equal(got, want) {
			t.Fatalf("prompt %v, want %v", got, want)
		}
	})
}

func TestRecoverAndResume(t *testing.T) {
	// interrupted starts a run, closes the engine mid-answer and recovers in a new one answering with turns.
	interrupted := func(t *testing.T, turns ...providertest.Turn) (*fixture, Ref) {
		f := newFixture(t, providertest.Turn{Text: []string{"cut"}, Hang: true})
		ref := f.send("hi", "req-1")
		f.waitFor("message.delta", ref.RunID)
		before := len(f.stored())
		f.eng.Close()
		if after := len(f.stored()); after != before || f.runState(ref.RunID) != "running" {
			t.Fatalf("Close wrote %d events; state %s", after-before, f.runState(ref.RunID))
		}
		f.newEngine(turns...)
		if err := f.eng.Recover(bg); err != nil {
			t.Fatal(err)
		}
		return f, ref
	}

	t.Run("Close then Recover in a new engine marks the run interrupted and asks nothing", func(t *testing.T) {
		f, ref := interrupted(t)
		if s := f.runState(ref.RunID); s != "interrupted" {
			t.Fatalf("state %s", s)
		}
		if n := len(f.model.Requests()); n != 0 {
			t.Fatalf("the model was asked %d times", n)
		}
		if p := f.storedOf("run.paused"); len(p) != 1 || decodeAs[event.RunPaused](t, p[0]).Reason != "interrupted" {
			t.Fatalf("paused %+v", p)
		}
		f.checkLog("interrupted")
	})

	t.Run("Resume asks again and finishes done; Resume of a done run is ErrNotInterrupted", func(t *testing.T) {
		f, ref := interrupted(t, providertest.Turn{Text: []string{"again"}})
		if err := f.eng.Resume(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if got := f.prompt(0); !slices.Equal(got, []string{"user:hi"}) {
			t.Fatalf("prompt %v", got)
		}
		if err := f.eng.Resume(bg, ref.RunID); !errors.Is(err, ErrNotInterrupted) {
			t.Fatalf("Resume of a done run: %v", err)
		}
		if err := f.eng.Resume(bg, "missing"); !errors.Is(err, ErrRunNotFound) {
			t.Fatalf("Resume of an unknown run: %v", err)
		}
	})

	t.Run("a new message to an interrupted chat resumes its run", func(t *testing.T) {
		f, ref := interrupted(t, providertest.Turn{Text: []string{"a1"}}, providertest.Turn{Text: []string{"a2"}})
		more := f.start(Spec{ChatID: ref.ChatID, Text: "more", RequestID: "req-2"})
		if more.RunID != ref.RunID {
			t.Fatalf("went to run %s, not %s", more.RunID, ref.RunID)
		}
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if a, b := f.prompt(0), f.prompt(1); !slices.Equal(a, []string{"user:hi"}) ||
			!slices.Equal(b, []string{"user:hi", "assistant:a1", "user:more"}) {
			t.Fatalf("prompts %v then %v", a, b)
		}
	})
}

func TestSharing(t *testing.T) {
	t.Run("two chats share the lease: the second starts after the first finishes", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"a"}}, providertest.Turn{Text: []string{"b"}})
		release := f.model.holdCall(1)
		a := f.send("first", "req-1")
		f.entered()
		b := f.send("second", "req-2")
		waitUntil(t, func() bool {
			s := f.sched.State()
			return s.Holder == a.RunID && len(s.Waiting) == 1 && s.Waiting[0] == sched.Waiting{RunID: b.RunID, Why: waitWhy}
		})
		release()
		f.finished(a.RunID)
		f.finished(b.RunID)
		seqOf := func(typ, runID string) int64 {
			for _, e := range f.stored() {
				if e.Type == typ && e.Stream == "run:"+runID {
					return e.Seq
				}
			}
			t.Fatalf("no %s for %s", typ, runID)
			return 0
		}
		if seqOf("run.started", b.RunID) < seqOf("message.completed", a.RunID) {
			t.Fatal("the second run started before the first answered")
		}
		if got := f.prompt(1); !slices.Equal(got, []string{"user:second"}) {
			t.Fatalf("second prompt %v", got)
		}
	})

	t.Run("Partials returns the text so far with its n; a delta at or below n is the one already included", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Reasoning: []string{"hm"}, Text: []string{"ab", "cd"}, Hang: true})
		ref := f.send("hi", "req-1")
		var deltas []event.MessageDelta
		for len(deltas) < 2 {
			deltas = append(deltas, decodeAs[event.MessageDelta](t, f.waitFor("message.delta", ref.RunID)))
		}
		parts := f.eng.Partials(event.Filter{Streams: []string{"run:*"}})
		if len(parts) != 1 || parts[0].Type != "message.partial" || parts[0].Stream != "run:"+ref.RunID {
			t.Fatalf("partials %+v", parts)
		}
		p := decodeAs[event.MessagePartial](t, parts[0])
		if p.Text != "abcd" || p.Reasoning != "hm" || p.N != 3 {
			t.Fatalf("partial %+v", p)
		}
		var included strings.Builder
		for _, d := range deltas {
			if d.N <= p.N {
				included.WriteString(d.Text)
			}
		}
		if included.String() != p.Text {
			t.Fatalf("deltas up to n make %q, partial has %q", included.String(), p.Text)
		}
		if other := f.eng.Partials(event.Filter{Streams: []string{"run:other"}}); len(other) != 0 {
			t.Fatalf("partials for another stream %+v", other)
		}
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if after := f.eng.Partials(event.Filter{}); len(after) != 0 {
			t.Fatalf("partials after stop %+v", after)
		}
	})
}

// say sends text to the chat (a new one when chatID is "") and waits for its run to finish.
func (f *fixture) say(chatID, text string) (Ref, event.RunFinished) {
	f.t.Helper()
	f.reqN++
	ref := f.start(Spec{ChatID: chatID, Model: "m1", Text: text, RequestID: fmt.Sprintf("req-%d", f.reqN)})
	return ref, f.finished(ref.RunID)
}

// long is name followed by filler, n runes in all.
func long(name string, n int) string { return name + " " + strings.Repeat("w", n-len(name)-1) }

// answer is a scripted answer with text.
func answer(text string) providertest.Turn { return providertest.Turn{Text: []string{text}} }

var overflow = providertest.Turn{Err: provider.ErrContextExceeded}

// compactions is the user message of every compaction request, in order.
func (f *fixture) compactions() []string {
	var out []string
	for _, r := range f.model.Requests() {
		if r.NoThinking {
			out = append(out, r.Messages[1].Parts[0].Text)
		}
	}
	return out
}

func TestCompaction(t *testing.T) {
	// A chat on a 2,048 window (Trigger 1,229, Target 768, one compaction piece ≤ 614): two short turns, a turn
	// of two 700-rune messages and a 1,200-rune fourth input take the prompt over Trigger. The last two turns
	// alone are over Target, so exactly they are kept, and the first two fit one compaction piece.
	longChat := func(t *testing.T, more ...providertest.Turn) (*fixture, string) {
		f := newFixture(t, append([]providertest.Turn{answer("a1"), answer("a2"), answer(long("a3", 700)),
			answer("SUMMARY ONE"), answer("a4")}, more...)...)
		f.size = 2048
		first, _ := f.say("", long("q1", 700))
		f.say(first.ChatID, long("q2", 700))
		f.say(first.ChatID, long("q3", 700))
		if _, fin := f.say(first.ChatID, long("q4", 1200)); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		return f, first.ChatID
	}

	t.Run("a long chat compacts before answering and keeps the last two turns", func(t *testing.T) {
		f, _ := longChat(t)
		reqs := f.model.Requests()
		if len(reqs) != 5 || !reqs[3].NoThinking || reqs[3].CacheKey != "" {
			t.Fatalf("requests %+v", reqs)
		}
		comp := f.compactions()[0]
		if !strings.HasPrefix(comp, "Previous summary:\nnone\n\n") || !strings.Contains(comp, "User: q1 ") ||
			!strings.Contains(comp, "Assistant: a2") || strings.Contains(comp, "q3") {
			t.Fatalf("compaction request %q", comp)
		}
		if sys := reqs[4].Messages[0].Parts[0].Text; !strings.HasSuffix(sys, "Summary of the earlier conversation:\nSUMMARY ONE") {
			t.Fatalf("system %q", sys)
		}
		want := []string{"user:" + long("q3", 700), "assistant:" + long("a3", 700), "user:" + long("q4", 1200)}
		if got := f.prompt(4); !slices.Equal(got, want) {
			t.Fatalf("answer prompt has %d messages: %.40v", len(got), got)
		}
		done := f.storedOf("compaction.completed")
		if len(done) != 1 {
			t.Fatalf("%d compactions stored", len(done))
		}
		c := decodeAs[event.CompactionCompleted](t, done[0])
		if c.Summary != "SUMMARY ONE" || c.FirstKeptSeq != f.storedOf("input.received")[2].Seq ||
			c.TokensAfter >= c.TokensBefore || c.TokensBefore <= 1229 {
			t.Fatalf("compaction %+v", c)
		}
		f.checkLog("compact")
	})

	t.Run("no message.delta or message.partial carries the compaction's text", func(t *testing.T) {
		f, _ := longChat(t)
		for _, e := range f.seen {
			if (e.Type == "message.delta" || e.Type == "message.partial") && strings.Contains(string(e.Data), "SUMMARY") {
				t.Fatalf("%s carries the summary: %s", e.Type, e.Data)
			}
		}
	})

	t.Run("a second compaction in a later run passes the first summary as prev", func(t *testing.T) {
		f, chatID := longChat(t, answer("a5"), answer("SUMMARY TWO A"), answer("SUMMARY TWO B"), answer("a6"))
		f.say(chatID, long("q5", 1200))
		if _, fin := f.say(chatID, long("q6", 700)); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		comps := f.compactions()
		if len(comps) < 2 || !strings.HasPrefix(comps[1], "Previous summary:\nSUMMARY ONE\n\n") {
			t.Fatalf("compactions %.60q", comps)
		}
		if n := len(f.storedOf("compaction.completed")); n != 2 {
			t.Fatalf("%d compactions stored", n)
		}
	})

	t.Run("a history too large for one compaction call is summarised in two pieces", func(t *testing.T) {
		// Two 1,400-rune answers (about 400 tokens each) are over one piece's 614 together.
		f := newFixture(t, answer(long("a1", 1400)), answer(long("a2", 1400)), answer(long("a3", 1400)),
			answer("PIECE ONE"), answer("PIECE TWO"), answer("a4"))
		f.size = 2048
		first, _ := f.say("", "q1")
		f.say(first.ChatID, "q2")
		f.say(first.ChatID, "q3")
		if _, fin := f.say(first.ChatID, "q4"); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		comps := f.compactions()
		if len(comps) != 2 || !strings.HasPrefix(comps[0], "Previous summary:\nnone\n\n") ||
			!strings.HasPrefix(comps[1], "Previous summary:\nPIECE ONE\n\n") {
			t.Fatalf("compactions %.60q", comps)
		}
		done := f.storedOf("compaction.completed")
		if len(done) != 1 || decodeAs[event.CompactionCompleted](t, done[0]).Summary != "PIECE TWO" {
			t.Fatalf("compactions stored %+v", done)
		}
	})

	// shortChat is two answered turns under Trigger by estimate but over Target (three 1,000-rune inputs make
	// 938 tokens), so a forced plan has the first turn to summarise; the third input is answered with turns.
	q := func(n int) string { return long(fmt.Sprintf("q%d", n), 1000) }
	shortChat := func(t *testing.T, turns ...providertest.Turn) (*fixture, Ref) {
		f := newFixture(t, append([]providertest.Turn{answer("a1"), answer("a2")}, turns...)...)
		f.size = 2048
		first, _ := f.say("", q(1))
		f.say(first.ChatID, q(2))
		f.reqN++
		return f, f.start(Spec{ChatID: first.ChatID, Text: q(3), RequestID: "req-3"})
	}

	t.Run("a provider overflow on a short-by-estimate chat compacts and retries once", func(t *testing.T) {
		f, ref := shortChat(t, overflow, answer("SUM"), answer("a3"))
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if got := f.prompt(4); !slices.Equal(got, []string{"user:" + q(2), "assistant:a2", "user:" + q(3)}) {
			t.Fatalf("retry prompt has %d messages", len(got))
		}
		if !f.model.Requests()[3].NoThinking {
			t.Fatal("the overflow was not followed by a compaction")
		}
		f.checkLog("overflow_retry")
	})

	t.Run("a second overflow fails context_exceeded", func(t *testing.T) {
		f, ref := shortChat(t, overflow, answer("SUM"), overflow)
		fin := f.finished(ref.RunID)
		if fin.State != "failed" || fin.Error == nil || fin.Error.Code != "context_exceeded" {
			t.Fatalf("finished %+v", fin)
		}
		reqs := f.model.Requests()[2:]
		if len(reqs) != 3 || reqs[0].NoThinking || !reqs[1].NoThinking || reqs[2].NoThinking {
			t.Fatalf("%d requests in the run", len(reqs))
		}
		f.checkLog("overflow_fail")
	})

	t.Run("a compaction call that errors fails context_exceeded and stores no summary", func(t *testing.T) {
		f, ref := shortChat(t, overflow, providertest.Turn{Err: errors.New("connection reset")})
		fin := f.finished(ref.RunID)
		if fin.State != "failed" || fin.Error == nil || fin.Error.Code != "context_exceeded" {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.storedOf("compaction.completed")); n != 0 {
			t.Fatalf("%d compactions stored", n)
		}
	})

	t.Run("Stop during the compaction finishes stopped with no answer and no summary", func(t *testing.T) {
		f, ref := shortChat(t, overflow, providertest.Turn{Text: []string{"SUM"}, Hang: true})
		waitUntil(t, func() bool { return len(f.model.Requests()) == 4 })
		if parts := f.eng.Partials(event.Filter{}); len(parts) != 0 {
			t.Fatalf("partials during compaction %+v", parts)
		}
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if s := f.runState(ref.RunID); s != "stopped" {
			t.Fatalf("state %s", s)
		}
		if a, c := len(f.storedOf("message.completed")), len(f.storedOf("compaction.completed")); a != 2 || c != 0 {
			t.Fatalf("%d answers and %d compactions stored", a, c)
		}
	})

	t.Run("Close during the compaction, then Recover and Resume, compacts again and answers", func(t *testing.T) {
		f, ref := shortChat(t, overflow, providertest.Turn{Text: []string{"SUM"}, Hang: true})
		waitUntil(t, func() bool { return len(f.model.Requests()) == 4 })
		f.eng.Close()
		f.newEngine(overflow, answer("SUM"), answer("a3"))
		if err := f.eng.Recover(bg); err != nil {
			t.Fatal(err)
		}
		if s := f.runState(ref.RunID); s != "interrupted" {
			t.Fatalf("state %s", s)
		}
		if err := f.eng.Resume(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		reqs := f.model.Requests()
		if len(reqs) != 3 || !reqs[1].NoThinking {
			t.Fatalf("%d requests after Resume", len(reqs))
		}
		if n := len(f.storedOf("compaction.completed")); n != 1 {
			t.Fatalf("%d compactions stored", n)
		}
	})
}

// titleRequests is every request that asked for a title, in order.
func (f *fixture) titleRequests() []provider.Request {
	var out []provider.Request
	for _, r := range f.model.Requests() {
		if len(r.Messages) > 0 && r.Messages[0].Parts[0].Text == titlePrompt {
			out = append(out, r)
		}
	}
	return out
}

func (f *fixture) chatTitle(chatID string) (title, source string) {
	f.t.Helper()
	chat, _, err := f.store.Chat(bg, chatID)
	if err != nil {
		f.t.Fatal(err)
	}
	return chat.Title, chat.TitleSource
}

func TestTitle(t *testing.T) {
	t.Run("a chat's first answer is followed by a title request and chat.titled auto, then run.finished done", func(t *testing.T) {
		f := newTitleFixture(t, answer("Lifetimes are scopes."), answer(`"Rust Borrow Checker Basics."`))
		ref := f.send("How does the borrow checker work?", "req-1")
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		reqs := f.model.Requests()
		if len(reqs) != 2 {
			t.Fatalf("%d requests, want 2", len(reqs))
		}
		r := reqs[1]
		if !r.NoThinking || r.MaxOut != 24 || r.Model != "m1" || len(r.Messages) != 2 ||
			r.Messages[0].Role != "system" || r.Messages[0].Parts[0].Text != titlePrompt ||
			r.Messages[1].Role != "user" || r.Messages[1].Parts[0].Text != "How does the borrow checker work?" {
			t.Fatalf("title request %+v", r)
		}
		if title, source := f.chatTitle(ref.ChatID); title != "Rust Borrow Checker Basics" || source != "auto" {
			t.Fatalf("title %q (%s)", title, source)
		}
		for _, e := range f.seen {
			if (e.Type == "message.delta" || e.Type == "message.partial") && strings.Contains(string(e.Data), "Basics") {
				t.Fatalf("%s carries the title: %s", e.Type, e.Data)
			}
		}
		f.checkLog("title")
	})

	t.Run("a second run of the same chat makes no title request", func(t *testing.T) {
		f := newTitleFixture(t, answer("a1"), answer("Title One"), answer("a2"))
		first, _ := f.say("", "q1")
		if _, fin := f.say(first.ChatID, "q2"); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.titleRequests()); n != 1 {
			t.Fatalf("%d title requests, want 1", n)
		}
	})

	t.Run("a chat renamed by the user before its first answer gets no title request", func(t *testing.T) {
		f := newTitleFixture(t, answer("a1"), answer("Unwanted"))
		release := f.model.holdCall(1)
		ref := f.send("q1", "req-1")
		f.entered()
		if _, err := f.store.Log().Append(bg, "chat:"+ref.ChatID, event.ChatTitled{Title: "Mine", Source: "user"}); err != nil {
			t.Fatal(err)
		}
		release()
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.titleRequests()); n != 0 {
			t.Fatalf("%d title requests", n)
		}
		if title, source := f.chatTitle(ref.ChatID); title != "Mine" || source != "user" {
			t.Fatalf("title %q (%s)", title, source)
		}
	})

	t.Run("a failing title call leaves the cut title and the run finishes done", func(t *testing.T) {
		f := newTitleFixture(t, answer("a1"), providertest.Turn{Err: errors.New("connection reset")})
		ref := f.send("tell me a story about a fox", "req-1")
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if title, source := f.chatTitle(ref.ChatID); title != "tell me a story about a fox" || source != "auto" {
			t.Fatalf("title %q (%s)", title, source)
		}
		if n := len(f.storedOf("chat.titled")); n != 0 {
			t.Fatalf("%d chat.titled stored", n)
		}
	})

	t.Run("a title call that never ends is cut at the timeout", func(t *testing.T) {
		old := titleTimeout
		titleTimeout = 50 * time.Millisecond
		t.Cleanup(func() { titleTimeout = old })
		f := newTitleFixture(t, answer("a1"), providertest.Turn{Text: []string{"Half"}, Hang: true})
		ref := f.send("q1", "req-1")
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.storedOf("chat.titled")); n != 0 {
			t.Fatalf("%d chat.titled stored", n)
		}
		if title, _ := f.chatTitle(ref.ChatID); title != "q1" {
			t.Fatalf("title %q", title)
		}
	})

	t.Run("an input queued during the first answer is answered after the title, in the same run", func(t *testing.T) {
		f := newTitleFixture(t, answer("one!"), answer("Numbers"), answer("two!"))
		release := f.model.holdCall(1)
		ref := f.send("one", "req-1")
		f.entered()
		second := f.start(Spec{ChatID: ref.ChatID, Text: "two", RequestID: "req-2"})
		release()
		if fin := f.finished(ref.RunID); fin.State != "done" || second.RunID != ref.RunID {
			t.Fatalf("finished %+v; second run %s", fin, second.RunID)
		}
		reqs := f.model.Requests()
		if len(reqs) != 3 || reqs[0].NoThinking || !reqs[1].NoThinking || reqs[2].NoThinking {
			t.Fatalf("%d requests: %+v", len(reqs), reqs)
		}
		if got := f.prompt(2); !slices.Equal(got, []string{"user:one", "assistant:one!", "user:two"}) {
			t.Fatalf("second answer's prompt %v", got)
		}
		if title, _ := f.chatTitle(ref.ChatID); title != "Numbers" {
			t.Fatalf("title %q", title)
		}
	})

	t.Run("Stop while the title call hangs finishes stopped with the answer kept and no title", func(t *testing.T) {
		f := newTitleFixture(t, answer("a1"), providertest.Turn{Text: []string{"Half"}, Hang: true})
		ref := f.send("q1", "req-1")
		waitUntil(t, func() bool { return len(f.titleRequests()) == 1 })
		if err := f.eng.Stop(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if s := f.runState(ref.RunID); s != "stopped" {
			t.Fatalf("state %s", s)
		}
		completed := f.storedOf("message.completed")
		if len(completed) != 1 || decodeAs[event.MessageCompleted](t, completed[0]).Partial {
			t.Fatalf("answers %+v", completed)
		}
		if n := len(f.storedOf("chat.titled")); n != 0 {
			t.Fatalf("%d chat.titled stored", n)
		}
	})

	t.Run("Close during the title call, then Recover and Resume, finishes done with no title", func(t *testing.T) {
		f := newTitleFixture(t, answer("a1"), providertest.Turn{Text: []string{"Half"}, Hang: true})
		ref := f.send("q1", "req-1")
		waitUntil(t, func() bool { return len(f.titleRequests()) == 1 })
		f.eng.Close()
		if s := f.runState(ref.RunID); s != "running" {
			t.Fatalf("state after Close %s", s)
		}
		f.newEngine()
		if err := f.eng.Recover(bg); err != nil {
			t.Fatal(err)
		}
		if err := f.eng.Resume(bg, ref.RunID); err != nil {
			t.Fatal(err)
		}
		if fin := f.finished(ref.RunID); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.model.Requests()); n != 0 {
			t.Fatalf("the new engine asked %d times", n)
		}
		if n := len(f.storedOf("chat.titled")); n != 0 {
			t.Fatalf("%d chat.titled stored", n)
		}
	})
}

// replace sends Replace for the chat (edited to text when set) and waits for the new run to finish.
func (f *fixture) replace(chatID, text string) (Ref, event.RunFinished) {
	f.t.Helper()
	f.reqN++
	ref := f.start(Spec{ChatID: chatID, Text: text, RequestID: fmt.Sprintf("req-%d", f.reqN), Replace: true})
	return ref, f.finished(ref.RunID)
}

// retracted is the run ids of the chat's retracted messages, one per message, by seq.
func (f *fixture) retracted(chatID string) []string {
	f.t.Helper()
	msgs, _, _, err := f.store.Transcript(bg, chatID)
	if err != nil {
		f.t.Fatal(err)
	}
	var out []string
	for _, m := range msgs {
		if m.Retracted {
			out = append(out, m.RunID)
		}
	}
	return out
}

func TestReplace(t *testing.T) {
	t.Run("regenerate retracts the last run and a new run answers the same input without the old answer", func(t *testing.T) {
		f := newFixture(t, answer("a1"), answer("a2"), answer("a2 again"))
		first, _ := f.say("", "q1")
		second, _ := f.say(first.ChatID, "q2")
		ref, fin := f.replace(first.ChatID, "")
		if fin.State != "done" || ref.RunID == second.RunID || ref.ChatID != first.ChatID {
			t.Fatalf("ref %+v, finished %+v", ref, fin)
		}
		if got := f.prompt(2); !slices.Equal(got, []string{"user:q1", "assistant:a1", "user:q2"}) {
			t.Fatalf("prompt %v", got)
		}
		if got := f.retracted(first.ChatID); !slices.Equal(got, []string{second.RunID, second.RunID}) {
			t.Fatalf("retracted %v", got)
		}
		inputs := f.storedOf("input.received")
		if ref.Seq != inputs[len(inputs)-1].Seq {
			t.Fatalf("Ref.Seq %d is not the new input's seq", ref.Seq)
		}
		f.checkLog("regenerate")
	})

	t.Run("edit sends the new text; the old input and answer are not in the prompt", func(t *testing.T) {
		f := newFixture(t, answer("a1"), answer("a2"), answer("a2 edited"))
		first, _ := f.say("", "q1")
		f.say(first.ChatID, "q2")
		if _, fin := f.replace(first.ChatID, "q2 better"); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if got := f.prompt(2); !slices.Equal(got, []string{"user:q1", "assistant:a1", "user:q2 better"}) {
			t.Fatalf("prompt %v", got)
		}
	})

	t.Run("a last run with two inputs: regenerate sends both in order, edit replaces only the second", func(t *testing.T) {
		f := newFixture(t, answer("r1"), answer("r2"), answer("s1"), answer("s2"), answer("t1"), answer("t2"))
		release := f.model.holdCall(1)
		ref := f.send("one", "req-1")
		f.entered()
		f.start(Spec{ChatID: ref.ChatID, Text: "two", RequestID: "req-2"})
		release()
		f.finished(ref.RunID)

		regen := f.start(Spec{ChatID: ref.ChatID, RequestID: "re", Replace: true})
		f.finished(regen.RunID)
		var got []string
		for _, e := range f.storedOf("input.received") {
			if e.Stream == "run:"+regen.RunID {
				p := decodeAs[event.InputReceived](t, e)
				got = append(got, p.Text+"@"+p.RequestID)
			}
		}
		if !slices.Equal(got, []string{"one@re", "two@re:2"}) {
			t.Fatalf("regenerated inputs %v", got)
		}
		if a, b := f.prompt(2), f.prompt(3); !slices.Equal(a, []string{"user:one"}) ||
			!slices.Equal(b, []string{"user:one", "assistant:s1", "user:two"}) {
			t.Fatalf("prompts %v then %v", a, b)
		}

		edit := f.start(Spec{ChatID: ref.ChatID, Text: "TWO", RequestID: "ed", Replace: true})
		f.finished(edit.RunID)
		if got := f.prompt(5); !slices.Equal(got, []string{"user:one", "assistant:t1", "user:TWO"}) {
			t.Fatalf("edited prompt %v", got)
		}
	})

	t.Run("regenerate after a failed run asks its input again", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"half"}, Err: errors.New("connection reset")}, answer("whole"))
		first, fin := f.say("", "q1")
		if fin.State != "failed" {
			t.Fatalf("first finished %+v", fin)
		}
		if _, fin := f.replace(first.ChatID, ""); fin.State != "done" {
			t.Fatalf("retry finished %+v", fin)
		}
		if got := f.prompt(1); !slices.Equal(got, []string{"user:q1"}) {
			t.Fatalf("retry prompt %v", got)
		}
	})

	t.Run("a chat with a running or interrupted run is ErrChatBusy and nothing is appended", func(t *testing.T) {
		f := newFixture(t, providertest.Turn{Text: []string{"cut"}, Hang: true})
		ref := f.send("hi", "req-1")
		f.waitFor("message.delta", ref.RunID)
		check := func(state string) {
			t.Helper()
			before := len(f.stored())
			if _, err := f.eng.Start(bg, Spec{ChatID: ref.ChatID, RequestID: "re-" + state, Replace: true}); !errors.Is(err, ErrChatBusy) {
				t.Fatalf("%s: err = %v, want ErrChatBusy", state, err)
			}
			if after := len(f.stored()); after != before {
				t.Fatalf("%s: %d events appended", state, after-before)
			}
		}
		check("running")
		f.eng.Close()
		f.newEngine()
		if err := f.eng.Recover(bg); err != nil {
			t.Fatal(err)
		}
		check("interrupted")
	})

	t.Run("a chat with no messages left is ErrBadInput", func(t *testing.T) {
		f := newFixture(t, answer("a1"))
		ref, _ := f.say("", "q1")
		if _, err := f.store.Log().Append(bg, "chat:"+ref.ChatID, event.TurnRetracted{RunID: ref.RunID}); err != nil {
			t.Fatal(err)
		}
		before := len(f.stored())
		if _, err := f.eng.Start(bg, Spec{ChatID: ref.ChatID, RequestID: "re", Replace: true}); !errors.Is(err, ErrBadInput) {
			t.Fatalf("err = %v, want ErrBadInput", err)
		}
		if after := len(f.stored()); after != before {
			t.Fatalf("%d events appended", after-before)
		}
	})

	t.Run("Replace rejects a missing chat id, blank text and an unknown chat", func(t *testing.T) {
		f := newFixture(t)
		cases := []struct {
			name string
			spec Spec
			want error
		}{
			{"no chat id", Spec{RequestID: "r", Replace: true, Model: "m1"}, ErrBadInput},
			{"no request id", Spec{ChatID: "c", Replace: true}, ErrBadInput},
			{"blank text", Spec{ChatID: "c", RequestID: "r", Text: "  ", Replace: true}, ErrBadInput},
			{"text of 200,001 runes", Spec{ChatID: "c", RequestID: "r", Text: strings.Repeat("ă", 200_001), Replace: true}, ErrBadInput},
			{"unknown chat", Spec{ChatID: "missing", RequestID: "r", Replace: true}, store.ErrNotFound},
		}
		for _, tc := range cases {
			if _, err := f.eng.Start(bg, tc.spec); !errors.Is(err, tc.want) {
				t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
			}
		}
		if n := len(f.stored()); n != 0 {
			t.Fatalf("%d events appended", n)
		}
	})

	t.Run("the same request id twice returns the same run and appends nothing the second time", func(t *testing.T) {
		f := newFixture(t, answer("a1"), answer("a1 again"))
		first, _ := f.say("", "q1")
		spec := Spec{ChatID: first.ChatID, RequestID: "re", Replace: true}
		ref := f.start(spec)
		f.finished(ref.RunID)
		before := len(f.stored())
		again := f.start(spec)
		if again.RunID != ref.RunID || again.ChatID != ref.ChatID {
			t.Fatalf("again %+v, first %+v", again, ref)
		}
		if after := len(f.stored()); after != before {
			t.Fatalf("%d events appended", after-before)
		}
	})

	t.Run("a retracted run's compaction summary is not used; the earlier one is", func(t *testing.T) {
		f := newFixture(t, answer("a1"), answer("a2"), answer("a3"), answer("a3 again"))
		first, _ := f.say("", "q1")
		second, _ := f.say(first.ChatID, "q2")
		compact := func(runID, summary string, kept int64) {
			t.Helper()
			if _, err := f.store.Log().Append(bg, "run:"+runID, event.CompactionCompleted{
				ChatID: first.ChatID, Summary: summary, FirstKeptSeq: kept, TokensBefore: 100, TokensAfter: 50,
			}); err != nil {
				t.Fatal(err)
			}
		}
		compact(second.RunID, "EARLIER", f.storedOf("input.received")[1].Seq)
		third, _ := f.say(first.ChatID, "q3")
		compact(third.RunID, "RETRACTED", f.storedOf("input.received")[2].Seq)
		if _, fin := f.replace(first.ChatID, ""); fin.State != "done" {
			t.Fatalf("finished %+v", fin)
		}
		if sys := f.model.Requests()[3].Messages[0].Parts[0].Text; !strings.HasSuffix(sys, "Summary of the earlier conversation:\nEARLIER") {
			t.Fatalf("system %q", sys)
		}
		if got := f.prompt(3); !slices.Equal(got, []string{"user:q2", "assistant:a2", "user:q3"}) {
			t.Fatalf("prompt %v", got)
		}
	})
}

// waitUntil polls ok for at most 5 s.
func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 5 s")
		}
		time.Sleep(time.Millisecond)
	}
}
