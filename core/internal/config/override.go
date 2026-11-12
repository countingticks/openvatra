package config

import "sync"

// Override is main's POST /api/config snapshot, held in memory only: main sends resolved paths (the bundled exe, the
// default folder), and saving those would pin them in the store. Core's readers prefer it while it is set. Deleted
// once main stops owning the model settings.
type Override struct {
	mu       sync.RWMutex
	cur      *Models
	onChange func()
}

func NewOverride() *Override { return &Override{} }

// Set replaces the whole snapshot after validating it; an invalid one changes nothing.
func (o *Override) Set(m Models) error {
	if err := m.Validate(); err != nil {
		return err
	}
	o.mu.Lock()
	o.cur = &m
	notify := o.onChange
	o.mu.Unlock()
	if notify != nil {
		notify() // outside the lock: it may call Get
	}
	return nil
}

// Get returns the snapshot; false until the first accepted Set.
func (o *Override) Get() (Models, bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	if o.cur == nil {
		return Models{}, false
	}
	return *o.cur, true
}

// OnChange sets the function Set calls after every accepted snapshot. core uses it to push a fresh model list to the
// UI: a new models folder changes what is listed although no model changed state.
func (o *Override) OnChange(fn func()) {
	o.mu.Lock()
	o.onChange = fn
	o.mu.Unlock()
}
