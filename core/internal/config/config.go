// Package config holds the settings Electron main sends to core. Main owns settings.json and pushes the values over
// POST /api/config (on start and on every change), so core never reads a settings file and the two can't disagree.
package config

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ModelOptions are one model's own settings.
type ModelOptions struct {
	// Args go after Config.SharedArgs, so a model can override a shared flag (llama-server keeps the last).
	Args []string `json:"args"`
	// IdleUnloadMinutes overrides Config.IdleUnloadMinutes for this model. A pointer, because "not set" (nil: use
	// the global value) and "never" (0) are different choices.
	IdleUnloadMinutes *int `json:"idleUnloadMinutes"`
	// MMProj switches the detected vision projector off when false; nil (main sent nothing) means on.
	MMProj *bool `json:"mmproj"`
}

// Config is one complete snapshot. Empty strings mean "not chosen yet".
type Config struct {
	LlamaServerPath string `json:"llamaServerPath"`
	ModelsDir       string `json:"modelsDir"`
	// EmbeddingModel is a model id.
	EmbeddingModel string `json:"embeddingModel"`
	// IdleUnloadMinutes is 0 for "never unload" (main sends null).
	IdleUnloadMinutes int `json:"idleUnloadMinutes"`
	// SharedArgs go to every model's llama-server. Like Args, an argument list handed straight to the process,
	// never a command string, so nothing is interpreted by a shell.
	SharedArgs []string                `json:"sharedArgs"`
	Options    map[string]ModelOptions `json:"options"`
}

// Flags core itself decides: main may not override them through arguments. src/shared/args.ts keeps the same list.
var reservedFlags = map[string]bool{
	"-m": true, "--model": true, "--host": true, "--port": true,
	"--embedding": true, "--embeddings": true, "-mm": true, "--mmproj": true,
}

// Validate rejects values core must not act on. The caller is local, but still not trusted to be bug-free.
func (c Config) Validate() error {
	if c.IdleUnloadMinutes < 0 {
		return errors.New("idleUnloadMinutes must not be negative")
	}
	if err := validateArgs(c.SharedArgs); err != nil {
		return fmt.Errorf("sharedArgs: %w", err)
	}
	for id, o := range c.Options {
		if err := validateArgs(o.Args); err != nil {
			return fmt.Errorf("options for %q: %w", id, err)
		}
		if o.IdleUnloadMinutes != nil && *o.IdleUnloadMinutes < 0 {
			return fmt.Errorf("options for %q: idleUnloadMinutes must not be negative", id)
		}
	}
	return nil
}

// IdleTimeout is how long model id may sit unused before core unloads it: its own setting if it has one, else the
// global one. Zero means never.
func (c Config) IdleTimeout(id string) time.Duration {
	minutes := c.IdleUnloadMinutes
	if own := c.Options[id].IdleUnloadMinutes; own != nil {
		minutes = *own
	}
	return time.Duration(minutes) * time.Minute
}

// UseMMProj reports whether model id should get its vision projector (when one was found). On unless switched off.
func (c Config) UseMMProj(id string) bool {
	own := c.Options[id].MMProj
	return own == nil || *own
}

func validateArgs(args []string) error {
	for _, arg := range args {
		if strings.ContainsRune(arg, 0) {
			return errors.New("an argument contains a NUL character")
		}
		if name, _, _ := strings.Cut(arg, "="); reservedFlags[name] {
			return fmt.Errorf("%s is set by core and can't be overridden", name)
		}
	}
	return nil
}

// Store is the live config, safe for the handler and the router to use at the same time.
type Store struct {
	mu       sync.RWMutex
	cur      Config
	onChange func()
}

func NewStore() *Store { return &Store{} }

// Get returns the current config.
func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Set replaces the whole config after validating it; an invalid one changes nothing.
func (s *Store) Set(c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	s.cur = c
	notify := s.onChange
	s.mu.Unlock()
	if notify != nil {
		notify() // outside the lock: it may call Get
	}
	return nil
}

// OnChange sets the function Set calls after every accepted config. core uses it to push a fresh model list to
// the UI: a new models folder changes what is listed although no model changed state.
func (s *Store) OnChange(f func()) {
	s.mu.Lock()
	s.onChange = f
	s.mu.Unlock()
}
