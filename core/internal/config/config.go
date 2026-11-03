// Package config holds the settings Electron main sends to core. Main owns settings.json and pushes the values over
// POST /api/config (on start and on every change), so core never reads a settings file and the two can't disagree.
package config

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// ModelOptions are one model's own settings.
type ModelOptions struct {
	// Args is an argument list handed straight to the process, never a command string, so nothing is interpreted by
	// a shell. "--no-mmproj" in it stops core from adding the detected projector.
	Args []string `json:"args"`
}

// Config is one complete snapshot. Empty strings mean "not chosen yet".
type Config struct {
	LlamaServerPath string `json:"llamaServerPath"`
	ModelsDir       string `json:"modelsDir"`
	// EmbeddingModel is a model id.
	EmbeddingModel string `json:"embeddingModel"`
	// IdleUnloadMinutes is 0 for "never unload" (main sends null).
	IdleUnloadMinutes int                     `json:"idleUnloadMinutes"`
	Options           map[string]ModelOptions `json:"options"`
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
	for id, o := range c.Options {
		if err := validateArgs(o.Args); err != nil {
			return fmt.Errorf("options for %q: %w", id, err)
		}
	}
	return nil
}

// IdleTimeout is how long model id may sit unused before core unloads it. Zero means never. The embedding model never
// unloads: it is small, and every RAG question needs it first, so reloading it would delay answers by seconds to
// save little memory.
func (c Config) IdleTimeout(id string) time.Duration {
	if id == c.EmbeddingModel {
		return 0
	}
	return time.Duration(c.IdleUnloadMinutes) * time.Minute
}

// UseMMProj reports whether model id gets its vision projector (when one was found): always, unless its own
// arguments contain --no-mmproj, which llama-server itself also understands.
func (c Config) UseMMProj(id string) bool {
	return !slices.Contains(c.Options[id].Args, "--no-mmproj")
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
