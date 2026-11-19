// Package llamacpp is the provider that runs GGUF models with llama-server. It keeps at most
// one chat model and one embedding model loaded: asking for another chat model
// stops the current one first, and requests for a model that is still loading
// wait instead of failing. A model nobody has used for a while is unloaded. The
// shape follows llama-swap's proxy manager, cut down to two slots.
package llamacpp

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/seam"
)

// DefaultLoadTimeout is how long a request waits for a model to become ready.
const DefaultLoadTimeout = 3 * time.Minute

const stopGrace = 5 * time.Second

// Config wires the provider to the outside world.
type Config struct {
	// Plan turns a model id into what to start, or returns provider.ErrUnknownModel. Called under the slot lock, before
	// anything is stopped. embedding: the request is for the embedding slot.
	Plan func(id string, embedding bool) (engine.Spec, error)
	// Start starts the planned server and returns once it is healthy. ctx carries the load timeout.
	Start func(ctx context.Context, spec engine.Spec) (engine.Instance, error)
	// EmbeddingModel returns the id of the chosen embedding model, "" if none.
	// A function because the user can change the choice while core runs.
	EmbeddingModel func() string
	// LoadTimeout bounds one model load; zero means DefaultLoadTimeout.
	LoadTimeout time.Duration
	// IdleTimeout returns how long model id may sit unused before it is unloaded;
	// zero, or a nil function, means never. A function because the user can change
	// it while core runs, and per model because each model can have its own.
	IdleTimeout func(id string) time.Duration
	// AfterFunc runs f after d and returns a function that cancels it. Tests swap
	// in a fake clock; nil means the real one.
	AfterFunc func(d time.Duration, f func()) (stop func() bool)
	// List is what Plan can start (the models folder), for Models. nil = no models.
	List func() ([]provider.Model, error)
	// Client talks to llama-server; nil = a client with no overall timeout (an answer can take minutes).
	Client *http.Client
	// Record keeps what a load or an answer measured; nil = nothing is recorded. Called on the load's or the
	// answer's goroutine, never under a slot lock.
	Record func(Measurement)
}

// Measurement is what one chat load or answer measured, for the spec the plan gave.
type Measurement struct {
	Spec            engine.Spec
	Memory          engine.Resources // a load: the instance's Measured(); zero for an answer
	TokensPerSecond float64          // an answer: the median of the load's last five; 0 for a load
}

// speedsKept is how many answers' speeds the median is taken over.
const speedsKept = 5

// loaded is one model's life in a slot: loading, then ready (or failed).
type loaded struct {
	id    string
	spec  engine.Spec
	inst  engine.Instance // set before ready is closed, nil when the load failed
	ready chan struct{}   // closed when loading has finished, either way
	err   error           // set before ready is closed
	users sync.WaitGroup

	speedMu sync.Mutex // its own, not the slot's: answers finish while the slot is busy
	speeds  []float64  // the last answers' speeds on this load, oldest first

	// Guarded by the slot's mutex.
	active    int         // requests currently holding this model
	idleGen   int         // bumped whenever the idle timer is armed or cancelled
	stopTimer func() bool // cancels the armed idle timer, nil if none
}

type slot struct {
	mu       sync.Mutex
	cur      *loaded
	stopping chan struct{} // closed when the last retired server has exited; nil if none
}

// The compiler checks the seams a llama.cpp provider fills.
var (
	_ provider.Provider = (*Provider)(nil)
	_ provider.Resident = (*Provider)(nil)
	_ provider.Upstream = (*Provider)(nil)
)

// Provider owns the two slots; it fills every provider capability: Provider, Chat, Embedder, Counter, Resident and
// Upstream.
type Provider struct {
	cfg   Config
	slots [2]slot // indexed by provider.Kind

	mu      sync.Mutex // guards lastErr and subs
	lastErr map[string]string
	subs    map[chan struct{}]struct{}
}

func New(cfg Config) *Provider {
	if cfg.LoadTimeout == 0 {
		cfg.LoadTimeout = DefaultLoadTimeout
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{}
	}
	if cfg.AfterFunc == nil {
		cfg.AfterFunc = func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }
	}
	return &Provider{cfg: cfg, lastErr: map[string]string{}, subs: map[chan struct{}]struct{}{}}
}

// Describe says what this provider is.
func (r *Provider) Describe() seam.Descriptor {
	return seam.Descriptor{ID: ID, Title: "llama.cpp", Description: "Runs GGUF models on this PC with llama-server."}
}

// Models lists what Plan can start, as List reports it, each chat model with the context size it loads with.
func (r *Provider) Models(context.Context) ([]provider.Model, error) {
	if r.cfg.List == nil {
		return []provider.Model{}, nil
	}
	return r.cfg.List()
}

// Model looks model id up in List, with the context size it loads with; it starts nothing. chat.Service gets it as
// its Model func, and Complete loads the model.
func (r *Provider) Model(ctx context.Context, id string) (provider.Model, error) {
	models, err := r.Models(ctx)
	if err != nil {
		return provider.Model{}, err
	}
	for _, m := range models {
		if m.ID == id {
			return m, nil
		}
	}
	return provider.Model{}, provider.ErrUnknownModel
}

// Acquire returns the base URL of a ready server for the request and a release
// function the caller must call when the response is fully sent. For provider.KindEmbedding
// the model argument is ignored: the chosen embedding model always serves.
func (r *Provider) Acquire(ctx context.Context, kind provider.Kind, model string) (baseURL string, release func(), err error) {
	l, release, err := r.acquire(ctx, kind, model)
	if err != nil {
		return "", nil, err
	}
	return l.inst.BaseURL(), release, nil
}

// acquire is Acquire returning the loaded model itself.
func (r *Provider) acquire(ctx context.Context, kind provider.Kind, model string) (*loaded, func(), error) {
	if kind == provider.KindEmbedding {
		if model = r.cfg.EmbeddingModel(); model == "" {
			return nil, nil, provider.ErrNoEmbeddingModel
		}
	}
	s := &r.slots[kind]

	s.mu.Lock()
	l := s.cur
	if l == nil || l.id != model {
		// Plan first, so an unknown id fails without unloading what is running.
		spec, err := r.cfg.Plan(model, kind == provider.KindEmbedding)
		if err != nil {
			s.mu.Unlock()
			return nil, nil, err
		}
		next := &loaded{id: model, spec: spec, ready: make(chan struct{})}
		old := s.cur
		if old != nil {
			cancelIdle(old)
		}
		s.cur = next
		go r.load(s, old, next, s.stopping)
		l = next
	}
	// Add happens under the lock while l is current: a swap only calls Wait after
	// replacing s.cur under this same lock, so Add never races with Wait.
	l.users.Add(1)
	l.active++
	cancelIdle(l)
	s.mu.Unlock()
	r.notify()

	select {
	case <-l.ready:
	case <-ctx.Done():
		r.finish(s, l)
		return nil, nil, ctx.Err()
	}
	if l.err != nil {
		r.finish(s, l)
		return nil, nil, l.err
	}
	var once sync.Once
	return l, func() { once.Do(func() { r.finish(s, l) }) }, nil
}

// finish ends one request's hold on l; when it was the last, the idle clock starts.
func (r *Provider) finish(s *slot, l *loaded) {
	s.mu.Lock()
	l.active--
	l.users.Done()
	r.armIdle(s, l)
	s.mu.Unlock()
	r.notify()
}

func cancelIdle(l *loaded) {
	l.idleGen++
	if l.stopTimer != nil {
		l.stopTimer()
		l.stopTimer = nil
	}
}

// armIdle starts the idle timer if l is loaded, unused and still current. The
// caller holds s.mu. The generation check makes a timer that already fired but
// lost the race against a new request harmless.
func (r *Provider) armIdle(s *slot, l *loaded) {
	if r.cfg.IdleTimeout == nil || l.active > 0 || s.cur != l {
		return
	}
	select {
	case <-l.ready:
	default:
		return // still loading; load() arms the timer when it is done
	}
	if l.err != nil {
		return
	}
	d := r.cfg.IdleTimeout(l.id)
	if d <= 0 {
		return
	}
	cancelIdle(l)
	gen := l.idleGen
	l.stopTimer = r.cfg.AfterFunc(d, func() {
		s.mu.Lock()
		if s.cur == l && l.idleGen == gen && l.active == 0 {
			r.retire(s)
		}
		s.mu.Unlock()
		r.notify()
	})
}

// retire empties the slot and stops its server in the background. The caller
// holds s.mu. The model counts as stopped at once; a load that follows waits on
// s.stopping, so two servers never hold the GPU together.
func (r *Provider) retire(s *slot) {
	l := s.cur
	s.cur = nil
	cancelIdle(l)
	prev := s.stopping
	done := make(chan struct{})
	s.stopping = done
	go func() {
		defer close(done)
		if prev != nil {
			<-prev
		}
		<-l.ready // a half-started server must finish (or fail) before we stop it
		l.users.Wait()
		if l.err == nil {
			l.inst.Stop(stopGrace)
		}
	}()
}

// load replaces old (if any) with next. It runs on its own goroutine with its own
// timeout so that one impatient client cancelling cannot abort a load others wait for.
func (r *Provider) load(s *slot, old, next *loaded, after <-chan struct{}) {
	if after != nil {
		<-after
	}
	if old != nil {
		<-old.ready
		old.users.Wait()
		if old.err == nil {
			old.inst.Stop(stopGrace)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), r.cfg.LoadTimeout)
	inst, err := r.cfg.Start(ctx, next.spec)
	cancel()
	if err != nil {
		next.err = &provider.LoadError{Model: next.id, Err: err}
		r.mu.Lock()
		r.lastErr[next.id] = err.Error()
		r.mu.Unlock()
		// Forget the failure so the next request tries again.
		s.mu.Lock()
		if s.cur == next {
			s.cur = nil
		}
		s.mu.Unlock()
		close(next.ready)
		r.notify()
		return
	}

	next.inst = inst
	r.mu.Lock()
	delete(r.lastErr, next.id)
	r.mu.Unlock()
	close(next.ready)
	// Every waiter may have given up while we loaded; then nobody will release.
	// A request that already finished after ready closed armed the timer; arming
	// again here would restart its countdown late.
	s.mu.Lock()
	if next.stopTimer == nil {
		r.armIdle(s, next)
	}
	s.mu.Unlock()
	r.notify()
	if res, ok := inst.Measured(); ok && r.cfg.Record != nil && !next.spec.Embedding {
		r.cfg.Record(Measurement{Spec: next.spec, Memory: res})
	}
}

// recordSpeed adds one answer's speed to l's list and records the median of the list.
func (r *Provider) recordSpeed(l *loaded, tokensPerSecond float64) {
	if r.cfg.Record == nil || l.spec.Embedding {
		return
	}
	l.speedMu.Lock()
	l.speeds = append(l.speeds, tokensPerSecond)
	if len(l.speeds) > speedsKept {
		l.speeds = l.speeds[1:]
	}
	sorted := slices.Clone(l.speeds)
	l.speedMu.Unlock()
	slices.Sort(sorted)
	median := sorted[len(sorted)/2]
	if len(sorted)%2 == 0 {
		median = (sorted[len(sorted)/2-1] + median) / 2
	}
	r.cfg.Record(Measurement{Spec: l.spec, TokensPerSecond: median})
}

// Close stops every loaded server; call it when core shuts down.
func (r *Provider) Close() {
	for i := range r.slots {
		s := &r.slots[i]
		s.mu.Lock()
		if s.cur != nil {
			r.retire(s)
		}
		stopping := s.stopping
		s.mu.Unlock()
		if stopping != nil {
			<-stopping
		}
	}
}
