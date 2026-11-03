package router

import (
	"context"
	"sort"
)

// Model states the router reports. "stopped" is left to the caller: the router
// only knows the models it has touched.
const (
	StateLoading = "loading"
	StateReady   = "ready"
	StateError   = "error"
)

// ModelState is what the router knows about one model.
type ModelState struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Busy  bool   `json:"busy"`
	Error string `json:"error,omitempty"`
}

// Snapshot lists the loaded and loading models plus any whose last load failed.
func (r *Router) Snapshot() []ModelState {
	var out []ModelState
	seen := map[string]bool{}
	for i := range r.slots {
		s := &r.slots[i]
		s.mu.Lock()
		if l := s.cur; l != nil {
			st := ModelState{ID: l.id, State: StateLoading, Busy: l.active > 0}
			select {
			case <-l.ready:
				st.State = StateReady
			default:
			}
			out = append(out, st)
			seen[l.id] = true
		}
		s.mu.Unlock()
	}
	r.mu.Lock()
	for id, msg := range r.lastErr {
		if !seen[id] {
			out = append(out, ModelState{ID: id, State: StateError, Error: msg})
		}
	}
	r.mu.Unlock()
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out
}

// Subscribe returns a channel that receives a signal after any state change, and
// a function to stop listening. Signals coalesce: a slow reader gets one signal
// for several changes and should call Snapshot again.
func (r *Router) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.subs, ch)
		r.mu.Unlock()
	}
}

func (r *Router) notify() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subs {
		select {
		case ch <- struct{}{}:
		default: // a signal is already waiting
		}
	}
}

// Load loads a model by hand and returns once it is ready. The model is then
// idle, so the idle timer applies to it like to any other.
func (r *Router) Load(ctx context.Context, id string) error {
	kind := Chat
	if id == r.cfg.EmbeddingModel() {
		kind = Embedding
	}
	_, release, err := r.Acquire(ctx, kind, id)
	if err != nil {
		return err
	}
	release()
	return nil
}

// Unload stops a model by hand once its running requests finish and reports
// whether it was loaded. The server stops in the background.
func (r *Router) Unload(id string) bool {
	found := false
	for i := range r.slots {
		s := &r.slots[i]
		s.mu.Lock()
		if s.cur != nil && s.cur.id == id {
			r.retire(s)
			found = true
		}
		s.mu.Unlock()
	}
	if found {
		r.notify()
	}
	return found
}
