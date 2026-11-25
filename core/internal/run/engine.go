package run

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/countingticks/openvatra/core/internal/budget"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/profile"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/sched"
	"github.com/countingticks/openvatra/core/internal/store"
)

// Views is what the engine reads from the store's views; *store.Store implements it.
type Views interface {
	Chat(ctx context.Context, id string) (store.ChatRow, int64, error)
	Transcript(ctx context.Context, chatID string) ([]store.MessageRow, []store.RunRow, int64, error)
	Run(ctx context.Context, id string) (store.RunRow, int64, error)
	OpenRuns(ctx context.Context) ([]store.RunRow, error)
	Request(ctx context.Context, requestID string) (store.RequestRef, bool, error)
}

// Config is what an Engine needs.
type Config struct {
	Log      event.Log
	Views    Views
	Chat     provider.Chat
	Model    func(ctx context.Context, id string) (provider.Model, error) // context size; ErrUnknownModel
	Sched    sched.Scheduler
	Profiles *profile.Registry
	Counter  provider.Counter // nil = estimate the fixed part
	Now      func() time.Time // nil = time.Now
	Logger   *slog.Logger     // nil = discard
}

// Spec is one send from the user.
type Spec struct {
	ChatID    string // "" = a new chat
	Model     string // required for a new chat, ignored otherwise
	Profile   string // "" = "chat"
	Text      string
	RequestID string
	// Replace true: retract the chat's last turn and send its inputs again; Text, when set, replaces the last of them.
	Replace bool
	// ReplaceFrom (a run id): retract that run and every later one, then send Text as a new run. Needs Text and
	// ChatID; not with Replace.
	ReplaceFrom string
}

// Ref names the run a send went to; Seq is the log position a client reads the run from.
type Ref struct {
	RunID, ChatID string
	Seq           int64
}

var (
	ErrBadInput       = errors.New("bad input")
	ErrRunNotFound    = errors.New("run not found")
	ErrNotInterrupted = errors.New("run is not interrupted")
	ErrChatBusy       = errors.New("chat has an active run")
)

const (
	maxInputRunes      = 200_000
	defaultContextSize = 16_384
	readPage           = 1000
	defaultProfile     = "chat"
	waitWhy            = "another chat is answering"
)

// Engine is the only thing that advances runs: one worker goroutine per run that has something to do.
type Engine struct {
	c   Config
	log *slog.Logger
	now func() time.Time

	// mu is held while Start, Stop, Resume, Recover and a worker's finish read views and append, so a chat never
	// gets two runs and no input is appended to a run that is finishing. It is taken before the store's append
	// lock, never inside a projector or a bus subscriber.
	mu      sync.Mutex
	workers map[string]*worker
	closed  bool

	livesMu sync.Mutex
	lives   map[string]*live // the answer streaming in, per run with a worker
}

type worker struct {
	runID   string
	ctx     context.Context // the step context: cancelled by Stop and Close
	cancel  context.CancelFunc
	stopped bool // guarded by Engine.mu; set by Stop before it cancels ctx
	done    chan struct{}
	live    *live

	// The fixed part's exact size, counted the first time the run asks the model and kept for the rest of it.
	fixedTokens int
	counted     bool
}

// live is a run's answer so far. mu is held while a delta is added and published, and while Partials reads, so a
// client that subscribes and then asks for the partial sees every delta exactly once (dropping n ≤ the partial's).
type live struct {
	mu              sync.Mutex
	stream          string
	n               int // the run's delta counter, from 1; never reset within the run
	text, reasoning strings.Builder
	// reasoningFrom and reasoningTo bound the answer's thinking: the first reasoning delta to the first text delta
	// (or the last reasoning delta when no text follows).
	reasoningFrom, reasoningTo time.Time
}

// New returns an engine; call Recover once before serving.
func New(c Config) *Engine {
	e := &Engine{c: c, log: c.Logger, now: c.Now, workers: map[string]*worker{}, lives: map[string]*live{}}
	if e.log == nil {
		e.log = slog.New(slog.DiscardHandler)
	}
	if e.now == nil {
		e.now = time.Now
	}
	return e
}

// Start sends a user's input: to a new chat, a new run of an existing chat, or the chat's active run.
func (e *Engine) Start(ctx context.Context, s Spec) (Ref, error) {
	if s.Profile == "" {
		s.Profile = defaultProfile
	}
	bad := strings.TrimSpace(s.Text) == "" || utf8.RuneCountInString(s.Text) > maxInputRunes
	if s.Replace {
		// The text is optional: without it the last turn's inputs are sent again as they were.
		bad = (s.Text != "" && bad) || s.ChatID == ""
	}
	if s.ReplaceFrom != "" {
		bad = strings.TrimSpace(s.Text) == "" || utf8.RuneCountInString(s.Text) > maxInputRunes || s.ChatID == "" || s.Replace
	}
	if s.RequestID == "" || bad || (s.ChatID == "" && s.Model == "") {
		return Ref{}, ErrBadInput
	}
	if _, ok := e.c.Profiles.Get(s.Profile); !ok {
		return Ref{}, ErrBadInput
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if ref, ok, err := e.c.Views.Request(ctx, s.RequestID); err != nil {
		return Ref{}, err
	} else if ok {
		row, _, err := e.c.Views.Run(ctx, ref.RunID)
		if err != nil {
			return Ref{}, err
		}
		return Ref{RunID: ref.RunID, ChatID: ref.ChatID, Seq: row.LastSeq}, nil
	}
	if s.Replace {
		return e.replaceLocked(ctx, s)
	}
	if s.ReplaceFrom != "" {
		return e.replaceFromLocked(ctx, s)
	}

	chatID, model := s.ChatID, s.Model
	if chatID == "" {
		chatID = store.NewID()
		if _, err := e.c.Log.Append(ctx, "chat:"+chatID,
			event.ChatCreated{Model: model, Profile: s.Profile}, event.ChatModel{Model: model}); err != nil {
			return Ref{}, err
		}
	} else {
		chat, _, err := e.c.Views.Chat(ctx, chatID)
		if err != nil {
			return Ref{}, err
		}
		if chat.ActiveRun != "" {
			return e.sendLocked(ctx, chat, s)
		}
		model = chat.Model
	}

	runID := store.NewID()
	events, err := e.c.Log.Append(ctx, "run:"+runID,
		event.RunQueued{ChatID: chatID, Profile: s.Profile, Model: model, Origin: "user", RequestID: s.RequestID},
		event.InputReceived{ChatID: chatID, Text: s.Text, RequestID: s.RequestID})
	if err != nil {
		return Ref{}, err
	}
	e.log.Info("run queued", "run", runID, "chat", chatID)
	e.startLocked(runID)
	return Ref{RunID: runID, ChatID: chatID, Seq: events[1].Seq}, nil
}

// replaceLocked retracts the chat's last turn and starts a run with that turn's inputs, the last one replaced by
// s.Text when set (regenerate, retry and edit). The caller holds mu.
func (e *Engine) replaceLocked(ctx context.Context, s Spec) (Ref, error) {
	chat, _, err := e.c.Views.Chat(ctx, s.ChatID)
	if err != nil {
		return Ref{}, err
	}
	r, err := e.retractFrom(ctx, chat, "")
	if err != nil {
		return Ref{}, err
	}
	inputs := r.Inputs
	if s.Text != "" {
		inputs[len(inputs)-1] = s.Text
	}

	runID := store.NewID()
	payloads := []event.Payload{
		event.RunQueued{ChatID: chat.ID, Profile: s.Profile, Model: chat.Model, Origin: "user", RequestID: s.RequestID},
	}
	for i, text := range inputs {
		req := s.RequestID
		if i > 0 {
			req = fmt.Sprintf("%s:%d", s.RequestID, i+1)
		}
		payloads = append(payloads, event.InputReceived{ChatID: chat.ID, Text: text, RequestID: req})
	}
	// If this append fails, the retraction stays: the turn is gone and the user can send again.
	events, err := e.c.Log.Append(ctx, "run:"+runID, payloads...)
	if err != nil {
		return Ref{}, err
	}
	e.log.Info("run queued to replace the last turn", "run", runID, "chat", chat.ID, "retracted", r.Runs)
	e.startLocked(runID)
	return Ref{RunID: runID, ChatID: chat.ID, Seq: events[len(events)-1].Seq}, nil
}

// replaceFromLocked retracts runID and every later run, then sends s.Text alone as a new run. The caller holds mu.
func (e *Engine) replaceFromLocked(ctx context.Context, s Spec) (Ref, error) {
	chat, _, err := e.c.Views.Chat(ctx, s.ChatID)
	if err != nil {
		return Ref{}, err
	}
	r, err := e.retractFrom(ctx, chat, s.ReplaceFrom)
	if err != nil {
		return Ref{}, err
	}
	runID := store.NewID()
	// If this append fails, the retraction stays, as in replaceLocked.
	events, err := e.c.Log.Append(ctx, "run:"+runID,
		event.RunQueued{ChatID: chat.ID, Profile: s.Profile, Model: chat.Model, Origin: "user", RequestID: s.RequestID},
		event.InputReceived{ChatID: chat.ID, Text: s.Text, RequestID: s.RequestID})
	if err != nil {
		return Ref{}, err
	}
	e.log.Info("run queued to replace from a run", "run", runID, "chat", chat.ID, "from", s.ReplaceFrom, "retracted", r.Runs)
	e.startLocked(runID)
	return Ref{RunID: runID, ChatID: chat.ID, Seq: events[1].Seq}, nil
}

// Rewound is a rewind's result: the last turn.retracted's seq and the rewound run's first input.
type Rewound struct {
	Seq  int64
	Text string
}

// Rewind retracts runID and every later run of the chat that still has a message.
func (e *Engine) Rewind(ctx context.Context, chatID, runID string) (Rewound, error) {
	if runID == "" {
		return Rewound{}, ErrBadInput
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	chat, _, err := e.c.Views.Chat(ctx, chatID)
	if err != nil {
		return Rewound{}, err
	}
	r, err := e.retractFrom(ctx, chat, runID)
	if err != nil {
		return Rewound{}, err
	}
	e.log.Info("chat rewound", "chat", chat.ID, "run", runID, "retracted", r.Runs)
	return Rewound{Seq: r.Seq, Text: r.Inputs[0]}, nil
}

// retraction is what retractFrom appended: Seq is the last turn.retracted's seq, Inputs the first retracted
// run's user rows' text, by seq.
type retraction struct {
	Seq    int64
	Runs   int
	Inputs []string
}

// retractFrom retracts runID and every later run of chat that still has a message; runID "" means the last
// run with a message left. The caller holds mu.
func (e *Engine) retractFrom(ctx context.Context, chat store.ChatRow, runID string) (retraction, error) {
	if chat.ActiveRun != "" {
		return retraction{}, ErrChatBusy
	}
	msgs, runs, _, err := e.c.Views.Transcript(ctx, chat.ID)
	if err != nil {
		return retraction{}, err
	}
	// A run has a message when one of its rows is not retracted.
	has := map[string]bool{}
	for _, m := range msgs {
		if !m.Retracted {
			has[m.RunID] = true
		}
	}
	from := -1
	for i := len(runs) - 1; i >= 0; i-- {
		if !has[runs[i].ID] {
			continue
		}
		if runID == "" {
			from = i
			break
		}
		if runs[i].ID == runID {
			from = i
			break
		}
	}
	if from < 0 {
		if runID == "" {
			return retraction{}, ErrBadInput
		}
		return retraction{}, ErrRunNotFound
	}
	// The target's inputs are its user rows, by seq.
	var inputs []string
	for _, m := range msgs {
		if m.RunID != runs[from].ID || m.Retracted || m.Role != "user" {
			continue
		}
		var parts []event.MessagePart
		if err := json.Unmarshal(m.Parts, &parts); err != nil {
			return retraction{}, fmt.Errorf("message %d: %w", m.Seq, err)
		}
		inputs = append(inputs, textOf(parts))
	}
	if len(inputs) == 0 {
		return retraction{}, ErrBadInput
	}
	var payloads []event.Payload
	for _, r := range runs[from:] {
		if has[r.ID] && (runID != "" || r.ID == runs[from].ID) {
			payloads = append(payloads, event.TurnRetracted{RunID: r.ID})
		}
	}
	events, err := e.c.Log.Append(ctx, "chat:"+chat.ID, payloads...)
	if err != nil {
		return retraction{}, err
	}
	return retraction{Seq: events[len(events)-1].Seq, Runs: len(payloads), Inputs: inputs}, nil
}

// sendLocked adds an input to the chat's active run; a cut-off run is resumed by it. The caller holds mu.
func (e *Engine) sendLocked(ctx context.Context, chat store.ChatRow, s Spec) (Ref, error) {
	payloads := []event.Payload{event.InputReceived{ChatID: chat.ID, Text: s.Text, RequestID: s.RequestID}}
	resume := chat.ActiveState == string(Interrupted)
	if resume {
		payloads = append(payloads, event.RunResumed{ChatID: chat.ID})
	}
	events, err := e.c.Log.Append(ctx, "run:"+chat.ActiveRun, payloads...)
	if err != nil {
		return Ref{}, err
	}
	if resume {
		e.log.Info("run resumed by a new input", "run", chat.ActiveRun, "chat", chat.ID)
		e.startLocked(chat.ActiveRun)
	}
	return Ref{RunID: chat.ActiveRun, ChatID: chat.ID, Seq: events[0].Seq}, nil
}

// Stop cancels the run's model call and finishes it stopped, keeping any text written so far.
func (e *Engine) Stop(ctx context.Context, runID string) error {
	e.mu.Lock()
	w := e.workers[runID]
	if w == nil {
		defer e.mu.Unlock()
		row, _, err := e.c.Views.Run(ctx, runID)
		if errors.Is(err, store.ErrNotFound) {
			return ErrRunNotFound
		}
		if err != nil {
			return err
		}
		if isFinished(Status(row.State)) {
			return nil
		}
		_, err = e.c.Log.Append(ctx, "run:"+runID, event.RunFinished{ChatID: row.ChatID, State: string(Stopped)})
		if err == nil {
			e.log.Info("run finished", "run", runID, "chat", row.ChatID, "state", Stopped)
		}
		return err
	}
	w.stopped = true
	w.cancel()
	e.mu.Unlock()
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Resume restarts an interrupted run, which asks again for its unanswered input.
func (e *Engine) Resume(ctx context.Context, runID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	row, _, err := e.c.Views.Run(ctx, runID)
	if errors.Is(err, store.ErrNotFound) {
		return ErrRunNotFound
	}
	if err != nil {
		return err
	}
	if Status(row.State) != Interrupted {
		return ErrNotInterrupted
	}
	if _, err := e.c.Log.Append(ctx, "run:"+runID, event.RunResumed{ChatID: row.ChatID}); err != nil {
		return err
	}
	e.log.Info("run resumed", "run", runID, "chat", row.ChatID)
	e.startLocked(runID)
	return nil
}

// Recover marks every run left open by the last core as interrupted. No worker starts, so no model loads at login.
func (e *Engine) Recover(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	runs, err := e.c.Views.OpenRuns(ctx)
	if err != nil {
		return err
	}
	for _, r := range runs {
		if r.Origin != "user" || e.workers[r.ID] != nil {
			continue
		}
		if _, err := e.c.Log.Append(ctx, "run:"+r.ID,
			event.RunPaused{ChatID: r.ChatID, Reason: "interrupted"}); err != nil {
			return err
		}
		e.log.Info("run interrupted", "run", r.ID, "chat", r.ChatID)
	}
	return nil
}

// Partials is one message.partial per run whose answer is streaming and whose stream f matches.
func (e *Engine) Partials(f event.Filter) []event.Event {
	e.livesMu.Lock()
	lives := make([]*live, 0, len(e.lives))
	for _, l := range e.lives {
		if f.Match(l.stream) {
			lives = append(lives, l)
		}
	}
	e.livesMu.Unlock()

	out := []event.Event{}
	for _, l := range lives {
		l.mu.Lock()
		// An answer just completed has an empty buffer: there is nothing to show until its next delta.
		if l.n > 0 && (l.text.Len() > 0 || l.reasoning.Len() > 0) {
			out = append(out, event.New(l.stream,
				event.MessagePartial{Text: l.text.String(), Reasoning: l.reasoning.String(), N: l.n}, e.now()))
		}
		l.mu.Unlock()
	}
	return out
}

// ContextUse is the size of the chat's next prompt, where its tokens go, and its model's context size.
type ContextUse struct {
	Used, Size int
	Parts      budget.Parts
}

// ContextUse is how many tokens the chat's next prompt is expected to take, and its model's context size.
//
// Every input is counted, queued ones included, and the fixed part is estimated: counting it would load the model.
// A model no longer installed gives size 0.
func (e *Engine) ContextUse(ctx context.Context, chatID string) (ContextUse, error) {
	var size int
	chat, _, err := e.c.Views.Chat(ctx, chatID)
	if err != nil {
		return ContextUse{}, err
	}
	p, ok := e.c.Profiles.Get(chat.Profile)
	if !ok {
		p, _ = e.c.Profiles.Get(defaultProfile)
	}
	window := defaultContextSize
	model, err := e.c.Model(ctx, chat.Model)
	var refused *provider.RefusedError
	switch {
	case errors.Is(err, provider.ErrUnknownModel), errors.As(err, &refused):
	case err != nil:
		return ContextUse{}, err
	default:
		if model.Context != 0 {
			window = model.Context
		}
		size = window
	}
	in, err := e.input(ctx, State{ChatID: chatID, Model: chat.Model}, p.SystemPrompt(e.now()))
	if err != nil {
		return ContextUse{}, err
	}
	plan := budget.Assemble(in, budget.NewWindow(window))
	return ContextUse{Used: plan.Tokens, Size: size, Parts: plan.Parts}, nil
}

// Close cancels every worker's step without writing events and waits for the workers to exit; their runs stay
// open for the next core's Recover.
func (e *Engine) Close() {
	e.mu.Lock()
	e.closed = true
	var done []chan struct{}
	for _, w := range e.workers {
		w.cancel()
		done = append(done, w.done)
	}
	e.mu.Unlock()
	for _, d := range done {
		<-d
	}
}

func isFinished(s Status) bool { return s == Done || s == Stopped || s == Failed }

// startLocked starts the run's worker unless one is running. The caller holds mu.
func (e *Engine) startLocked(runID string) {
	if e.closed || e.workers[runID] != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	w := &worker{runID: runID, ctx: ctx, cancel: cancel, done: make(chan struct{}), live: &live{stream: "run:" + runID}}
	e.workers[runID] = w
	e.livesMu.Lock()
	e.lives[runID] = w.live
	e.livesMu.Unlock()
	go e.work(w)
}

// removeLocked forgets the worker. The caller holds mu.
func (e *Engine) removeLocked(w *worker) {
	delete(e.workers, w.runID)
	e.livesMu.Lock()
	delete(e.lives, w.runID)
	e.livesMu.Unlock()
	w.cancel()
}

func (e *Engine) work(w *worker) {
	defer close(w.done)
	st, err := e.catchUp(w.ctx, State{}, w.runID)
	if err != nil {
		e.exit(w, State{ID: w.runID}, nil, err)
		return
	}
	e.decideTitle(w, &st)
	for {
		if w.ctx.Err() != nil { // stopped or closed between steps
			e.exit(w, st, nil, nil)
			return
		}
		p, ok := e.c.Profiles.Get(st.Profile)
		if !ok {
			e.exit(w, st, nil, fmt.Errorf("unknown profile %q", st.Profile))
			return
		}
		var out stepOutcome
		switch Next(st, p) {
		case AskModel:
			st, out = e.ask(w, st, p)
		case Title: // ask titles right after the first answer; this is only reached if it could not
			st, out = e.titleStep(w, st)
		default:
			if e.settle(w, &st, p) {
				return
			}
			continue
		}
		if out.end {
			e.exit(w, st, out.partial, out.err)
			return
		}
	}
}

// settle runs when Next is Idle or Finish: under mu it reads what arrived since and, if nothing changed the
// action, finishes the run (Finish) or forgets the worker (Idle). It reports whether the worker is done.
func (e *Engine) settle(w *worker, st *State, p profile.Profile) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if w.ctx.Err() != nil { // stopped or closed while waiting for mu
		e.endLocked(w, *st, nil, nil)
		return true
	}
	next, err := e.catchUp(w.ctx, *st, w.runID)
	if err != nil {
		e.removeLocked(w)
		e.log.Error("run read failed", "run", w.runID, "err", err)
		return true
	}
	*st = next
	switch Next(next, p) {
	case Idle:
		e.removeLocked(w)
		return true
	case Finish:
		e.writeEnd(next, event.RunFinished{ChatID: next.ChatID, State: string(Done)}, nil)
		e.removeLocked(w)
		return true
	}
	return false
}

// stepOutcome is how an AskModel step ended when it ends the run.
type stepOutcome struct {
	end     bool
	partial *partialAnswer // text written before the step ended, if any
	err     error          // why it failed; nil with end = cancelled
}

type partialAnswer struct {
	parts []event.MessagePart
	stats event.MessageStats
}

// ask answers the oldest input in the inbox under a lease.
func (e *Engine) ask(w *worker, st State, p profile.Profile) (State, stepOutcome) {
	lease, err := e.c.Sched.Acquire(w.ctx, sched.Request{RunID: st.ID, Model: st.Model, Class: sched.Interactive, Why: waitWhy})
	if err != nil {
		return st, stepOutcome{end: true} // only a cancelled ctx ends Acquire
	}
	defer lease.Release()

	if st.Status == Queued {
		if _, err := e.c.Log.Append(w.ctx, "run:"+st.ID, event.RunStarted{ChatID: st.ChatID}); err != nil {
			return st, stepOutcome{end: true, err: w.ctxErr(err)}
		}
		e.log.Info("run started", "run", st.ID, "chat", st.ChatID)
		// Read rather than fold the appended event: an input may have landed before it.
		if st, err = e.catchUp(w.ctx, st, st.ID); err != nil {
			return st, stepOutcome{end: true, err: w.ctxErr(err)}
		}
	}
	model, err := e.c.Model(w.ctx, st.Model)
	if err != nil {
		return st, stepOutcome{end: true, err: w.ctxErr(err)}
	}
	contextSize := model.Context
	if contextSize == 0 {
		contextSize = defaultContextSize
	}
	system := p.SystemPrompt(e.now())
	e.countFixed(w, lease, st, system)
	in, err := e.input(w.ctx, st, system)
	if err != nil {
		return st, stepOutcome{end: true, err: w.ctxErr(err)}
	}
	in.FixedTokens = w.fixedTokens
	win := budget.NewWindow(contextSize)

	// Plan, compact when the plan says so, and send. After the provider says the prompt is too long, plan once more
	// as if over the trigger: that compacts if anything older is left, and otherwise the run fails.
	var (
		plan       budget.Plan
		res        provider.Result
		started    time.Time
		overflowed bool // the provider refused this step's prompt once
		compacted  bool // compacted since the last plan that was sent
	)
	for {
		plan = budget.Assemble(in, win)
		switch plan.Verdict {
		case budget.Refuse:
			return st, stepOutcome{end: true, err: plan.Err}
		case budget.Prune:
			e.log.Error("unexpected prune", "run", st.ID, "chat", st.ChatID)
			return st, stepOutcome{end: true, err: errUnexpectedPrune}
		case budget.Compact:
			if compacted { // Assemble keeps the compacted part whole, so this is a bug, not a long chat
				return st, stepOutcome{end: true, err: errContextExceeded}
			}
			if in, err = e.compact(w, lease, st, in, plan, win); err != nil {
				if w.ctx.Err() != nil {
					return st, stepOutcome{end: true}
				}
				e.log.Warn("run compaction failed", "run", st.ID, "chat", st.ChatID, "err", err)
				return st, stepOutcome{end: true, err: errContextExceeded}
			}
			compacted = true
			continue
		}
		if overflowed && !compacted { // nothing older left to summarise
			return st, stepOutcome{end: true, err: errContextExceeded}
		}

		started = time.Now()
		res, err = e.c.Chat.Complete(lease.Context(), plan.Request, w.live.add(e.c.Log, e.now))
		if !errors.Is(err, provider.ErrContextExceeded) || w.live.hasText() || w.ctx.Err() != nil {
			break
		}
		if overflowed {
			err = errContextExceeded
			break
		}
		overflowed, compacted, in.Force = true, false, true
	}
	elapsed := time.Since(started)

	if w.ctx.Err() != nil || err != nil {
		var partial *partialAnswer
		if parts := w.live.parts(); textOf(parts) != "" {
			partial = &partialAnswer{parts: parts, stats: statsOf(res.Usage, plan.Tokens, parts, elapsed, contextSize, w.live.reasoningMs())}
		}
		if w.ctx.Err() != nil {
			err = nil
		}
		return st, stepOutcome{end: true, partial: partial, err: err}
	}

	parts := messageParts(res.Parts)
	stats := statsOf(res.Usage, plan.Tokens, parts, elapsed, contextSize, w.live.reasoningMs())
	if _, err := e.appendCompleted(w.ctx, st, parts, false, stats); err != nil {
		return st, stepOutcome{end: true, err: w.ctxErr(err)}
	}
	e.log.Info("run answered", "run", st.ID, "chat", st.ChatID, "promptTokens", stats.PromptTokens,
		"answerTokens", stats.AnswerTokens, "exact", stats.Exact, "durationMs", stats.DurationMs)

	next, err := e.catchUp(w.ctx, st, st.ID)
	if err != nil {
		return st, stepOutcome{end: true, err: w.ctxErr(err)}
	}
	// The title is asked under this answer's lease, before any input queued behind it (decision 27).
	if Next(next, p) == Title {
		e.title(w, lease, next)
		next.WantTitle = false
	}
	return next, stepOutcome{}
}

// decideTitle sets st.WantTitle once, when the worker starts: a run titles its chat when its profile asks for
// titles, it is the chat's first run, it has no answer yet and the user has not named the chat. A run resumed after
// its answer gets no title.
func (e *Engine) decideTitle(w *worker, st *State) {
	p, ok := e.c.Profiles.Get(st.Profile)
	if !ok || !p.Title || st.Answers > 0 {
		return
	}
	want, err := e.firstUntitledRun(w.ctx, *st)
	if err != nil {
		if w.ctx.Err() == nil {
			e.log.Warn("run title check failed", "run", st.ID, "chat", st.ChatID, "err", err)
		}
		return
	}
	st.WantTitle = want
}

// firstUntitledRun reports whether st is its chat's first run and the chat's title is not the user's.
func (e *Engine) firstUntitledRun(ctx context.Context, st State) (bool, error) {
	chat, _, err := e.c.Views.Chat(ctx, st.ChatID)
	if err != nil || chat.TitleSource == "user" {
		return false, err
	}
	_, runs, _, err := e.c.Views.Transcript(ctx, st.ChatID)
	if err != nil {
		return false, err
	}
	return len(runs) > 0 && runs[0].ID == st.ID, nil
}

// titleStep asks for the title under a lease of its own.
func (e *Engine) titleStep(w *worker, st State) (State, stepOutcome) {
	lease, err := e.c.Sched.Acquire(w.ctx, sched.Request{RunID: st.ID, Model: st.Model, Class: sched.Interactive, Why: waitWhy})
	if err != nil {
		return st, stepOutcome{end: true} // only a cancelled ctx ends Acquire
	}
	defer lease.Release()
	e.title(w, lease, st)
	st.WantTitle = false
	return st, stepOutcome{}
}

var (
	errEmptyTitle = errors.New("empty title")
	errUserTitled = errors.New("the user named the chat")
)

// title asks the model for a short title from the run's first input and stores it as the chat's auto title.
// Nothing streams. On any failure nothing is written and the title cut from the first message stays.
func (e *Engine) title(w *worker, lease sched.Lease, st State) {
	title, err := e.askTitle(w, lease, st)
	if err == nil && title == "" {
		err = errEmptyTitle
	}
	if err == nil {
		_, err = e.c.Log.Append(w.ctx, "chat:"+st.ChatID, event.ChatTitled{Title: title, Source: "auto"})
	}
	switch {
	case errors.Is(err, errUserTitled):
	case err != nil:
		e.log.Warn("chat title not made", "run", st.ID, "chat", st.ChatID, "err", err)
	default:
		e.log.Info("chat titled", "run", st.ID, "chat", st.ChatID)
	}
}

func (e *Engine) askTitle(w *worker, lease sched.Lease, st State) (string, error) {
	// Checked again here: the user may have renamed the chat while its first answer was being written.
	chat, _, err := e.c.Views.Chat(w.ctx, st.ChatID)
	if err != nil {
		return "", err
	}
	if chat.TitleSource == "user" {
		return "", errUserTitled
	}
	msgs, _, _, err := e.c.Views.Transcript(w.ctx, st.ChatID)
	if err != nil {
		return "", err
	}
	first := ""
	for _, m := range msgs { // by seq: the run's first user row is its first input
		if m.RunID == st.ID && m.Role == "user" {
			var parts []event.MessagePart
			if err := json.Unmarshal(m.Parts, &parts); err != nil {
				return "", fmt.Errorf("message %d: %w", m.Seq, err)
			}
			first = textOf(parts)
			break
		}
	}
	if first == "" {
		return "", errors.New("no first input")
	}
	ctx, cancel := context.WithTimeout(lease.Context(), titleTimeout)
	defer cancel()
	res, err := e.c.Chat.Complete(ctx, provider.Request{
		Model: st.Model,
		Messages: []provider.Message{
			provider.TextMessage("system", titlePrompt),
			provider.TextMessage("user", firstRunes(first, titleInputRunes)),
		},
		MaxOut:     titleMaxOut,
		NoThinking: true,
	}, func(provider.Delta) {})
	if err == nil {
		err = ctx.Err() // a cancelled or timed-out call returns what it had without an error
	}
	if err != nil {
		return "", err
	}
	return cleanTitle(textOf(messageParts(res.Parts))), nil
}

// ctxErr hides an error caused by the step being cancelled: the run then ends as stopped or closed, not failed.
func (w *worker) ctxErr(err error) error {
	if w.ctx.Err() != nil {
		return nil
	}
	return err
}

var (
	errContextExceeded = errors.New("context exceeded after compaction")
	errUnexpectedPrune = errors.New("unexpected prune")
)

// compactionProfile is the profile whose prompt summarises a chat's older turns.
const compactionProfile = "compaction"

// perMessageTokens is budget's allowance for the role markers around one message; the compaction call's system
// message costs its estimate plus this.
const perMessageTokens = 8

// compact summarises the messages before plan.CutAt, oldest piece first, each piece's summary carried into the next,
// and records the result as compaction.completed. It streams nothing: the summary is not an answer. It returns the
// input with the new summary and only the kept messages; on any error nothing is written.
func (e *Engine) compact(w *worker, lease sched.Lease, st State, in budget.Input, plan budget.Plan,
	win budget.Window) (budget.Input, error) {
	p, ok := e.c.Profiles.Get(compactionProfile)
	if !ok {
		return in, fmt.Errorf("no %q profile", compactionProfile)
	}
	system := p.SystemPrompt(e.now())
	cut := len(in.Messages)
	for i, m := range in.Messages {
		if m.Seq == plan.CutAt {
			cut = i
			break
		}
	}
	pieces := budget.Pieces(in.Messages[:cut], win, budget.EstimateTokens(system)+perMessageTokens)
	if len(pieces) == 0 {
		return in, errors.New("nothing to summarise")
	}
	summary := ""
	if in.Summary != nil {
		summary = in.Summary.Text
	}
	for i, piece := range pieces {
		res, err := e.c.Chat.Complete(lease.Context(), budget.CompactRequest(st.Model, system, summary, piece, win),
			func(provider.Delta) {})
		if err != nil {
			return in, fmt.Errorf("piece %d: %w", i+1, err)
		}
		if err := w.ctx.Err(); err != nil {
			return in, err
		}
		summary = strings.TrimSpace(textOf(messageParts(res.Parts)))
		if summary == "" {
			return in, fmt.Errorf("piece %d: empty summary", i+1)
		}
	}

	out := in
	out.Force = false
	out.Messages = in.Messages[cut:]
	out.Known = budget.Known{} // in.Known is the last exact answer: it stays only if it was kept
	for _, m := range out.Messages {
		if m.Seq == in.Known.Seq {
			out.Known = in.Known
		}
	}
	// Until the event is appended its seq is unknown; any seq after the messages' plans the same.
	out.Summary = &budget.Summary{Text: summary, FirstKeptSeq: plan.CutAt, Seq: math.MaxInt64}
	after := budget.Assemble(out, win).Tokens
	events, err := e.c.Log.Append(w.ctx, "run:"+st.ID, event.CompactionCompleted{
		ChatID: st.ChatID, Summary: summary, FirstKeptSeq: plan.CutAt, TokensBefore: plan.Tokens, TokensAfter: after,
	})
	if err != nil {
		return in, err
	}
	out.Summary.Seq = events[0].Seq
	e.log.Info("run compacted", "run", st.ID, "chat", st.ChatID, "tokensBefore", plan.Tokens, "tokensAfter", after,
		"pieces", len(pieces))
	return out, nil
}

// countFixed counts the fixed part once per run. Without a counter, or when counting fails, it stays 0 and the
// budget estimates it.
func (e *Engine) countFixed(w *worker, lease sched.Lease, st State, system string) {
	if w.counted {
		return
	}
	w.counted = true
	if e.c.Counter == nil {
		return
	}
	n, err := e.c.Counter.Count(lease.Context(), st.Model, system)
	if err != nil {
		if w.ctx.Err() == nil {
			e.log.Warn("fixed part not counted", "run", st.ID, "chat", st.ChatID, "err", err)
		}
		return
	}
	w.fixedTokens = n
}

// appendCompleted stores the answer and empties the live buffer in one step under the live lock, so Partials never
// returns text that is also in a stored message.
func (e *Engine) appendCompleted(ctx context.Context, st State, parts []event.MessagePart, partial bool,
	stats event.MessageStats) ([]event.Event, error) {
	w := e.workerLive(st.ID)
	if w != nil {
		w.mu.Lock()
		defer w.mu.Unlock()
	}
	events, err := e.c.Log.Append(ctx, "run:"+st.ID, event.MessageCompleted{
		ChatID: st.ChatID, Parts: parts, Partial: partial, Model: st.Model, Stats: stats,
	})
	if err == nil && w != nil {
		w.text.Reset()
		w.reasoning.Reset()
		w.reasoningFrom, w.reasoningTo = time.Time{}, time.Time{}
	}
	return events, err
}

func (e *Engine) workerLive(runID string) *live {
	e.livesMu.Lock()
	defer e.livesMu.Unlock()
	return e.lives[runID]
}

// exit ends the worker after a step that ended the run: Close writes nothing, Stop finishes stopped, an error
// finishes failed. Partial text is stored first in the last two cases.
func (e *Engine) exit(w *worker, st State, partial *partialAnswer, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.endLocked(w, st, partial, err)
}

func (e *Engine) endLocked(w *worker, st State, partial *partialAnswer, err error) {
	defer e.removeLocked(w)
	if st.ChatID == "" {
		e.log.Error("run could not be read", "run", w.runID, "err", err)
		return
	}
	switch {
	case w.stopped:
		e.writeEnd(st, event.RunFinished{ChatID: st.ChatID, State: string(Stopped)}, partial)
	case err != nil:
		runErr := failure(err)
		e.log.Warn("run step failed", "run", st.ID, "chat", st.ChatID, "code", runErr.Code, "err", err)
		e.writeEnd(st, event.RunFinished{ChatID: st.ChatID, State: string(Failed), Error: runErr}, partial)
	default:
		// Close: the run stays open for Recover.
	}
}

// writeEnd appends the partial answer, if any, then run.finished. The caller holds mu.
func (e *Engine) writeEnd(st State, fin event.RunFinished, partial *partialAnswer) {
	ctx := context.Background() // the step context is cancelled by now; these writes must still land
	if partial != nil {
		if _, err := e.appendCompleted(ctx, st, partial.parts, true, partial.stats); err != nil {
			e.log.Error("run partial answer not stored", "run", st.ID, "err", err)
		}
	}
	if _, err := e.c.Log.Append(ctx, "run:"+st.ID, fin); err != nil {
		e.log.Error("run finish not stored", "run", st.ID, "err", err)
		return
	}
	code := ""
	if fin.Error != nil {
		code = fin.Error.Code
	}
	e.log.Info("run finished", "run", st.ID, "chat", st.ChatID, "state", fin.State, "code", code)
}

func failure(err error) *event.RunError {
	var load *provider.LoadError
	var refused *provider.RefusedError
	switch {
	case errors.As(err, &refused):
		return &event.RunError{Code: "model_load_failed", Message: refused.Reason}
	case errors.Is(err, provider.ErrUnknownModel):
		return &event.RunError{Code: "model_not_found", Message: "This model is no longer in the models folder."}
	case errors.As(err, &load):
		return &event.RunError{Code: "model_load_failed", Message: "The model failed to load. Check its settings."}
	case errors.Is(err, budget.ErrContextTooSmall):
		return &event.RunError{Code: "context_too_small",
			Message: "This model's context is too small to chat. Pick a larger context in model settings."}
	case errors.Is(err, budget.ErrMessageTooLong):
		return &event.RunError{Code: "message_too_long", Message: "This message is too long for this model."}
	case errors.Is(err, errContextExceeded):
		return &event.RunError{Code: "context_exceeded",
			Message: "This chat is too long for this model, even after summarising."}
	}
	return &event.RunError{Code: "backend_failed", Message: "The model stopped answering."}
}

// catchUp folds the run's events after st.LastSeq, a page at a time.
func (e *Engine) catchUp(ctx context.Context, st State, runID string) (State, error) {
	f := event.Filter{Streams: []string{"run:" + runID}}
	for {
		events, err := e.c.Log.Read(ctx, st.LastSeq, f, readPage)
		if err != nil {
			return st, err
		}
		for _, ev := range events {
			st = Fold(st, ev)
		}
		if len(events) < readPage {
			return st, nil
		}
	}
}

// input is what the budget plans the chat's next prompt from: the latest summary and the conversation from its
// first kept message on, up to and including the oldest input of st still unanswered (every input when st.ID is "").
// FixedTokens is left 0 for the caller.
func (e *Engine) input(ctx context.Context, st State, system string) (budget.Input, error) {
	in := budget.Input{Model: st.Model, CacheKey: st.ChatID, Fixed: system}
	msgs, _, _, err := e.c.Views.Transcript(ctx, st.ChatID)
	if err != nil {
		return in, err
	}
	var latest *store.MessageRow
	for i, m := range msgs {
		// A retracted run's summary no longer applies; the one before it, if any, does.
		if m.Role == "summary" && !m.Retracted && (latest == nil || m.Seq > latest.Seq) {
			latest = &msgs[i]
		}
	}
	if latest != nil {
		sum, err := e.summary(ctx, *latest)
		if err != nil {
			return in, err
		}
		in.Summary = &sum
	}

	var rows []store.MessageRow
	for _, m := range Conversation(msgs, st.ID) {
		if m.Role != "summary" {
			rows = append(rows, m)
		}
	}
	if in.Summary != nil {
		for i, m := range rows {
			if m.Seq == in.Summary.FirstKeptSeq {
				rows = rows[i:]
				break
			}
		}
	}
	for _, m := range rows {
		var parts []event.MessagePart
		if err := json.Unmarshal(m.Parts, &parts); err != nil {
			return in, fmt.Errorf("message %d: %w", m.Seq, err)
		}
		in.Messages = append(in.Messages, budget.Message{Seq: m.Seq, Role: m.Role, Parts: parts, Failed: m.Failed,
			Retracted: m.Retracted})
		if m.Role == "assistant" && !m.Failed && !m.Retracted {
			if k, ok := known(m); ok {
				in.Known = k
			}
		}
	}
	return in, nil
}

// summary reads the compaction behind a summary row: the row has its text, the event its first kept message.
func (e *Engine) summary(ctx context.Context, row store.MessageRow) (budget.Summary, error) {
	events, err := e.c.Log.Read(ctx, row.Seq-1, event.Filter{Streams: []string{"run:" + row.RunID}}, 1)
	if err != nil {
		return budget.Summary{}, err
	}
	if len(events) == 0 || events[0].Seq != row.Seq {
		return budget.Summary{}, fmt.Errorf("summary %d: no compaction event", row.Seq)
	}
	var p event.CompactionCompleted
	if err := json.Unmarshal(events[0].Data, &p); err != nil {
		return budget.Summary{}, fmt.Errorf("summary %d: %w", row.Seq, err)
	}
	return budget.Summary{Text: p.Summary, FirstKeptSeq: p.FirstKeptSeq, Seq: row.Seq}, nil
}

// known is the exact prompt size an answer reports, if it does.
func known(m store.MessageRow) (budget.Known, bool) {
	var s event.MessageStats
	if len(m.Stats) == 0 || json.Unmarshal(m.Stats, &s) != nil || !s.Exact {
		return budget.Known{}, false
	}
	return budget.Known{PromptTokens: s.PromptTokens, Seq: m.Seq}, true
}

// Conversation puts msgs (by seq) in the order the model reads them, ending with the input runID answers now (every
// message when runID is "": the order a person reads the chat in).
//
// A run answers its inputs one at a time and in order (Steps: 1), so its n-th answer belongs to its n-th input. By
// seq, an input sent mid-answer lands before that answer; here each answer follows its own input instead. The
// input being answered is the run's first one without an answer; the inputs queued behind it are left out. Runs of
// one chat never overlap, so each run's messages stay together.
func Conversation(msgs []store.MessageRow, runID string) []store.MessageRow {
	var order []string
	byRun := map[string][]store.MessageRow{}
	for _, m := range msgs {
		if _, ok := byRun[m.RunID]; !ok {
			order = append(order, m.RunID)
		}
		byRun[m.RunID] = append(byRun[m.RunID], m)
	}
	out := make([]store.MessageRow, 0, len(msgs))
	for _, id := range order {
		var inputs, answers, other []store.MessageRow
		for _, m := range byRun[id] {
			switch m.Role {
			case "user":
				inputs = append(inputs, m)
			case "assistant":
				answers = append(answers, m)
			default:
				other = append(other, m) // summaries: input reads the latest one apart
			}
		}
		out = append(out, other...)
		for i, in := range inputs {
			out = append(out, in)
			if i < len(answers) {
				out = append(out, answers[i])
			} else if id == runID {
				return out // the input to answer now: the ones behind it wait their turn
			}
		}
		if len(answers) > len(inputs) {
			out = append(out, answers[len(inputs):]...)
		}
	}
	return out
}

// textOf joins the text parts; reasoning is never sent back to the model.
func textOf(parts []event.MessagePart) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Kind == "text" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// messageParts keeps the text and reasoning of a provider's answer, in its order.
func messageParts(parts []provider.Part) []event.MessagePart {
	out := []event.MessagePart{}
	for _, p := range parts {
		switch p.Kind {
		case provider.PartText:
			out = append(out, event.MessagePart{Kind: "text", Text: p.Text})
		case provider.PartReasoning:
			out = append(out, event.MessagePart{Kind: "reasoning", Text: p.Text})
		}
	}
	return out
}

// statsOf is the provider's usage plus the step's timing; without exact counts both are estimated.
func statsOf(u provider.Usage, promptEstimate int, parts []event.MessagePart, elapsed time.Duration,
	contextSize int, reasoningMs int64) event.MessageStats {
	s := event.MessageStats{
		PromptTokens: u.PromptTokens, AnswerTokens: u.AnswerTokens, Exact: u.Exact,
		TokensPerSecond: u.TokensPerSecond, FirstTokenMs: u.FirstTokenMs, ReasoningMs: reasoningMs,
		DurationMs: elapsed.Milliseconds(), ContextSize: contextSize,
	}
	if !u.Exact {
		s.PromptTokens = promptEstimate
		s.AnswerTokens = 0
		for _, p := range parts {
			s.AnswerTokens += budget.EstimateTokens(p.Text)
		}
	}
	return s
}

// add numbers the delta, keeps its text and publishes it, all under the live lock.
func (l *live) add(log event.Log, now func() time.Time) func(provider.Delta) {
	return func(d provider.Delta) {
		if d.Text == "" || (d.Kind != provider.PartText && d.Kind != provider.PartReasoning) {
			return
		}
		l.mu.Lock()
		defer l.mu.Unlock()
		l.n++
		if d.Kind == provider.PartText {
			if l.text.Len() == 0 && !l.reasoningFrom.IsZero() {
				l.reasoningTo = now()
			}
			l.text.WriteString(d.Text)
			log.Publish(l.stream, event.MessageDelta{Text: d.Text, N: l.n})
		} else {
			if l.text.Len() == 0 {
				if l.reasoningFrom.IsZero() {
					l.reasoningFrom = now()
				}
				l.reasoningTo = now()
			}
			l.reasoning.WriteString(d.Text)
			log.Publish(l.stream, event.ReasoningDelta{Text: d.Text, N: l.n})
		}
	}
}

// reasoningMs is how long the model thought for the answer so far.
func (l *live) reasoningMs() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.reasoningFrom.IsZero() {
		return 0
	}
	return l.reasoningTo.Sub(l.reasoningFrom).Milliseconds()
}

func (l *live) hasText() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.text.Len() > 0
}

// parts is the answer so far, reasoning first, as message.completed stores it.
func (l *live) parts() []event.MessagePart {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []event.MessagePart{}
	if l.reasoning.Len() > 0 {
		out = append(out, event.MessagePart{Kind: "reasoning", Text: l.reasoning.String()})
	}
	if l.text.Len() > 0 {
		out = append(out, event.MessagePart{Kind: "text", Text: l.text.String()})
	}
	return out
}
