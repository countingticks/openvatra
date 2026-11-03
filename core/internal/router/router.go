// Package router decides which llama-server answers a request. It keeps at most
// one chat model and one embedding model loaded: asking for another chat model
// stops the current one first, and requests for a model that is still loading
// wait instead of failing. A model nobody has used for a while is unloaded. The
// shape follows llama-swap's proxy manager, cut down to two slots.
package router

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Kind picks the slot a request uses.
type Kind int

const (
	Chat Kind = iota
	Embedding
)

var (
	// ErrUnknownModel means no model with that id exists on disk.
	ErrUnknownModel = errors.New("unknown model")
	// ErrNoEmbeddingModel means no embedding model has been chosen yet.
	ErrNoEmbeddingModel = errors.New("no embedding model chosen")
)

// DefaultLoadTimeout is how long a request waits for a model to become ready.
const DefaultLoadTimeout = 3 * time.Minute

const stopGrace = 5 * time.Second

// Backend is one model server. *process.Process satisfies it; tests use a fake.
type Backend interface {
	Start(ctx context.Context, timeout time.Duration) error
	Stop(grace time.Duration)
	BaseURL() string
}

// Config wires the router to the outside world.
type Config struct {
	// NewBackend builds (without starting) the server for a model id, or returns
	// ErrUnknownModel. The embedding flag tells it to add --embeddings.
	NewBackend func(id string, embedding bool) (Backend, error)
	// EmbeddingModel returns the id of the chosen embedding model, "" if none.
	// A function because the user can change the choice while core runs.
	EmbeddingModel func() string
	// LoadTimeout bounds one model load; zero means DefaultLoadTimeout.
	LoadTimeout time.Duration
	// IdleTimeout returns how long a model may sit unused before it is unloaded;
	// zero, or a nil function, means never. A function because the user can change
	// it while core runs.
	IdleTimeout func() time.Duration
	// AfterFunc runs f after d and returns a function that cancels it. Tests swap
	// in a fake clock; nil means the real one.
	AfterFunc func(d time.Duration, f func()) (stop func() bool)
}

// loaded is one model's life in a slot: loading, then ready (or failed).
type loaded struct {
	id      string
	backend Backend
	ready   chan struct{} // closed when loading has finished, either way
	err     error         // set before ready is closed
	users   sync.WaitGroup

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

// Router owns the two slots.
type Router struct {
	cfg   Config
	slots [2]slot // indexed by Kind

	mu      sync.Mutex // guards lastErr and subs
	lastErr map[string]string
	subs    map[chan struct{}]struct{}
}

func New(cfg Config) *Router {
	if cfg.LoadTimeout == 0 {
		cfg.LoadTimeout = DefaultLoadTimeout
	}
	if cfg.AfterFunc == nil {
		cfg.AfterFunc = func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop }
	}
	return &Router{cfg: cfg, lastErr: map[string]string{}, subs: map[chan struct{}]struct{}{}}
}

// Acquire returns the base URL of a ready server for the request and a release
// function the caller must call when the response is fully sent. For Embedding
// the model argument is ignored: the chosen embedding model always serves.
func (r *Router) Acquire(ctx context.Context, kind Kind, model string) (baseURL string, release func(), err error) {
	if kind == Embedding {
		if model = r.cfg.EmbeddingModel(); model == "" {
			return "", nil, ErrNoEmbeddingModel
		}
	}
	s := &r.slots[kind]

	s.mu.Lock()
	l := s.cur
	if l == nil || l.id != model {
		// Build first, so an unknown id fails without unloading what is running.
		b, err := r.cfg.NewBackend(model, kind == Embedding)
		if err != nil {
			s.mu.Unlock()
			return "", nil, err
		}
		next := &loaded{id: model, backend: b, ready: make(chan struct{})}
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
		return "", nil, ctx.Err()
	}
	if l.err != nil {
		r.finish(s, l)
		return "", nil, l.err
	}
	var once sync.Once
	return l.backend.BaseURL(), func() { once.Do(func() { r.finish(s, l) }) }, nil
}

// finish ends one request's hold on l; when it was the last, the idle clock starts.
func (r *Router) finish(s *slot, l *loaded) {
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
func (r *Router) armIdle(s *slot, l *loaded) {
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
	d := r.cfg.IdleTimeout()
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
func (r *Router) retire(s *slot) {
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
			l.backend.Stop(stopGrace)
		}
	}()
}

// load replaces old (if any) with next. It runs on its own goroutine with its own
// timeout so that one impatient client cancelling cannot abort a load others wait for.
func (r *Router) load(s *slot, old, next *loaded, after <-chan struct{}) {
	if after != nil {
		<-after
	}
	if old != nil {
		<-old.ready
		old.users.Wait()
		if old.err == nil {
			old.backend.Stop(stopGrace)
		}
	}

	if err := next.backend.Start(context.Background(), r.cfg.LoadTimeout); err != nil {
		next.err = fmt.Errorf("load %s: %w", next.id, err)
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

	r.mu.Lock()
	delete(r.lastErr, next.id)
	r.mu.Unlock()
	close(next.ready)
	// Every waiter may have given up while we loaded; then nobody will release.
	s.mu.Lock()
	r.armIdle(s, next)
	s.mu.Unlock()
	r.notify()
}

// Close stops every loaded server; call it when core shuts down.
func (r *Router) Close() {
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
