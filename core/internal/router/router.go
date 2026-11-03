// Package router decides which llama-server answers a request. It keeps at most
// one chat model and one embedding model loaded: asking for another chat model
// stops the current one first, and requests for a model that is still loading
// wait instead of failing. The shape follows llama-swap's proxy manager, cut down
// to two slots.
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
}

// loaded is one model's life in a slot: loading, then ready (or failed).
type loaded struct {
	id      string
	backend Backend
	ready   chan struct{} // closed when loading has finished, either way
	err     error         // set before ready is closed
	users   sync.WaitGroup
}

type slot struct {
	mu  sync.Mutex
	cur *loaded
}

// Router owns the two slots.
type Router struct {
	cfg   Config
	slots [2]slot // indexed by Kind
}

func New(cfg Config) *Router {
	if cfg.LoadTimeout == 0 {
		cfg.LoadTimeout = DefaultLoadTimeout
	}
	return &Router{cfg: cfg}
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
		s.cur = next
		go r.load(s, old, next)
		l = next
	}
	// Add happens under the lock while l is current: a swap only calls Wait after
	// replacing s.cur under this same lock, so Add never races with Wait.
	l.users.Add(1)
	s.mu.Unlock()

	select {
	case <-l.ready:
	case <-ctx.Done():
		l.users.Done()
		return "", nil, ctx.Err()
	}
	if l.err != nil {
		l.users.Done()
		return "", nil, l.err
	}
	return l.backend.BaseURL(), l.users.Done, nil
}

// load replaces old (if any) with next. It runs on its own goroutine with its own
// timeout so that one impatient client cancelling cannot abort a load others wait for.
func (r *Router) load(s *slot, old, next *loaded) {
	defer close(next.ready)

	if old != nil {
		<-old.ready // a half-started server must finish (or fail) before we stop it
		old.users.Wait()
		if old.err == nil {
			old.backend.Stop(stopGrace)
		}
	}

	if err := next.backend.Start(context.Background(), r.cfg.LoadTimeout); err != nil {
		next.err = fmt.Errorf("load %s: %w", next.id, err)
		// Forget the failure so the next request tries again.
		s.mu.Lock()
		if s.cur == next {
			s.cur = nil
		}
		s.mu.Unlock()
	}
}

// Close stops every loaded server; call it when core shuts down.
func (r *Router) Close() {
	for i := range r.slots {
		s := &r.slots[i]
		s.mu.Lock()
		l := s.cur
		s.cur = nil
		s.mu.Unlock()
		if l == nil {
			continue
		}
		<-l.ready
		if l.err == nil {
			l.backend.Stop(stopGrace)
		}
	}
}
