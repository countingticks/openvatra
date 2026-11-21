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

type fixture struct {
	t         *testing.T
	store     *store.Store
	bus       *event.Bus
	model     *gated
	sched     *sched.FIFO
	modelErrs map[string]error
	eng       *Engine
	events    <-chan event.Event
	seen      []event.Event // every event waitFor has read, in order
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
	f := &fixture{t: t, store: st, bus: bus, events: events, modelErrs: map[string]error{}}
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
			return provider.Model{ID: id, Kind: provider.ModelChat, Context: contextSize}, nil
		},
		Sched:    f.sched,
		Profiles: profile.Builtin(),
		Now:      func() time.Time { return clock },
	})
	return f.eng
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

	t.Run("context exceeded retries once with two fewer turns; a second overflow fails with context_too_small", func(t *testing.T) {
		f := newFixture(t,
			providertest.Turn{Text: []string{"a1"}},
			providertest.Turn{Err: provider.ErrContextExceeded}, providertest.Turn{Text: []string{"a2"}},
			providertest.Turn{Err: provider.ErrContextExceeded}, providertest.Turn{Err: provider.ErrContextExceeded},
		)
		first := f.send("q1", "req-1")
		f.finished(first.RunID)
		second := f.start(Spec{ChatID: first.ChatID, Text: "q2", RequestID: "req-2"})
		if fin := f.finished(second.RunID); fin.State != "done" {
			t.Fatalf("retry finished %+v", fin)
		}
		if a, b := f.prompt(1), f.prompt(2); len(a) != 3 || !slices.Equal(b, []string{"user:q2"}) {
			t.Fatalf("prompts %v then %v", a, b)
		}
		third := f.start(Spec{ChatID: first.ChatID, Text: "q3", RequestID: "req-3"})
		fin := f.finished(third.RunID)
		if fin.State != "failed" || fin.Error.Code != "context_too_small" ||
			fin.Error.Message != "This message is too long for this model." {
			t.Fatalf("finished %+v", fin)
		}
		if n := len(f.model.Requests()); n != 5 {
			t.Fatalf("%d requests, want 5", n)
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
