// Package sched decides which run may use the model next. Until Step 10 it hands out one lease at a time, in
// arrival order; classes, slots and preemption come later behind the same interface.
package sched

import (
	"context"
	"slices"
	"sync"
)

// Class is how urgent a request is. Interactive is the only value used in this step.
type Class int

const Interactive Class = 1

// Request asks for the right to use Model for one step of run RunID.
type Request struct {
	RunID string
	Model string
	Class Class
	Why   string // shown to others while this one holds the lease
}

// Lease is the right to use one slot of the model for one step.
type Lease interface {
	Context() context.Context // derived from the ctx given to Acquire
	Slot() int                // the server slot; always 0 in this step
	Release()
}

// Waiting is one run waiting for the lease and why.
type Waiting struct {
	RunID string `json:"runId"`
	Why   string `json:"why"`
}

// State is who holds the lease and who waits for it, oldest first.
type State struct {
	Holder  string    `json:"holder,omitempty"`
	Waiting []Waiting `json:"waiting"`
}

// Scheduler hands out leases.
type Scheduler interface {
	// Acquire blocks until req may use the model; cancelling ctx leaves the queue and returns ctx.Err().
	Acquire(ctx context.Context, req Request) (Lease, error)
	State() State
}

const defaultWhy = "another run is using the model"

// FIFO grants one lease at a time, first come first served.
type FIFO struct {
	onChange func(State)

	mu       sync.Mutex
	holder   *lease
	queue    []*waiter
	pending  []State // changes not yet given to onChange, oldest first
	flushing bool    // a goroutine is giving pending to onChange
}

type waiter struct {
	ctx   context.Context
	req   Request
	grant chan *lease // receives the lease once; buffered so Release never blocks
}

type lease struct {
	f        *FIFO
	req      Request
	ctx      context.Context
	cancel   context.CancelFunc
	released bool // guarded by f.mu
}

func (l *lease) Context() context.Context { return l.ctx }
func (l *lease) Slot() int                { return 0 }

// Release hands the lease to the oldest waiter. A second call does nothing.
func (l *lease) Release() {
	f := l.f
	f.mu.Lock()
	if l.released {
		f.mu.Unlock()
		return
	}
	f.releaseLocked(l)
	f.mu.Unlock()
	l.cancel()
	f.flush()
}

// NewFIFO returns a first-come scheduler; onChange, if not nil, gets every new State in order.
func NewFIFO(onChange func(State)) *FIFO {
	return &FIFO{onChange: onChange}
}

func (f *FIFO) Acquire(ctx context.Context, req Request) (Lease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	if f.holder == nil && len(f.queue) == 0 {
		l := f.grantLocked(ctx, req)
		f.mu.Unlock()
		f.flush()
		return l, nil
	}
	w := &waiter{ctx: ctx, req: req, grant: make(chan *lease, 1)}
	f.queue = append(f.queue, w)
	f.changedLocked()
	f.mu.Unlock()
	f.flush()

	select {
	case l := <-w.grant:
		return l, nil
	case <-ctx.Done():
	}
	f.mu.Lock()
	if i := slices.Index(f.queue, w); i >= 0 {
		f.queue = slices.Delete(f.queue, i, i+1)
		f.changedLocked()
		f.mu.Unlock()
		f.flush()
		return nil, ctx.Err()
	}
	f.mu.Unlock()
	// Granted while ctx ended: pass the lease on rather than leak it.
	(<-w.grant).Release()
	return nil, ctx.Err()
}

func (f *FIFO) State() State {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stateLocked()
}

func (f *FIFO) grantLocked(ctx context.Context, req Request) *lease {
	lctx, cancel := context.WithCancel(ctx)
	l := &lease{f: f, req: req, ctx: lctx, cancel: cancel}
	f.holder = l
	f.changedLocked()
	return l
}

func (f *FIFO) releaseLocked(l *lease) {
	l.released = true
	f.holder = nil
	if len(f.queue) == 0 {
		f.changedLocked()
		return
	}
	w := f.queue[0]
	f.queue = f.queue[1:]
	w.grant <- f.grantLocked(w.ctx, w.req)
}

func (f *FIFO) stateLocked() State {
	s := State{Waiting: make([]Waiting, 0, len(f.queue))}
	why := defaultWhy
	if f.holder != nil {
		s.Holder = f.holder.req.RunID
		if f.holder.req.Why != "" {
			why = f.holder.req.Why
		}
	}
	for _, w := range f.queue {
		s.Waiting = append(s.Waiting, Waiting{RunID: w.req.RunID, Why: why})
	}
	return s
}

func (f *FIFO) changedLocked() {
	if f.onChange != nil {
		f.pending = append(f.pending, f.stateLocked())
	}
}

// flush gives the pending states to onChange outside the lock. Only one goroutine flushes at a time, so the states
// arrive in the order the changes happened; a change made meanwhile (even from inside onChange) joins the queue.
func (f *FIFO) flush() {
	f.mu.Lock()
	if f.flushing {
		f.mu.Unlock()
		return
	}
	f.flushing = true
	for len(f.pending) > 0 {
		s := f.pending[0]
		f.pending = f.pending[1:]
		f.mu.Unlock()
		f.onChange(s)
		f.mu.Lock()
	}
	f.flushing = false
	f.mu.Unlock()
}
