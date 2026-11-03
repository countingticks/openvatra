// Package config holds the settings Electron main sends to core. Main owns settings.json and pushes the values over
// POST /api/config (on start and on every change), so core never reads a settings file and the two can't disagree.
package config

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// ModelOptions are the per-model llama-server tweaks. nil means "leave llama-server's default"; pointers, because
// 0 is a real choice for GPULayers (CPU only) and must differ from "not set".
type ModelOptions struct {
	ContextSize *int `json:"contextSize"`
	GPULayers   *int `json:"gpuLayers"`
	// ExtraArgs is an argument list handed straight to the process, never a command string, so nothing is
	// interpreted by a shell.
	ExtraArgs []string `json:"extraArgs"`
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

// Flags core itself decides: main may not override them through extraArgs.
var reservedFlags = map[string]bool{"-m": true, "--model": true, "--host": true, "--port": true, "--embeddings": true}

// Validate rejects values core must not act on. The caller is local, but still not trusted to be bug-free.
func (c Config) Validate() error {
	if c.IdleUnloadMinutes < 0 {
		return errors.New("idleUnloadMinutes must not be negative")
	}
	for id, o := range c.Options {
		if (o.ContextSize != nil && *o.ContextSize < 0) || (o.GPULayers != nil && *o.GPULayers < 0) {
			return fmt.Errorf("options for %q: contextSize and gpuLayers must not be negative", id)
		}
		for _, arg := range o.ExtraArgs {
			if strings.ContainsRune(arg, 0) {
				return fmt.Errorf("options for %q: an argument contains a NUL character", id)
			}
			if name, _, _ := strings.Cut(arg, "="); reservedFlags[name] {
				return fmt.Errorf("options for %q: %s is set by core and can't be overridden", id, name)
			}
		}
	}
	return nil
}

// Store is the live config, safe for the handler and the router to use at the same time.
type Store struct {
	mu  sync.RWMutex
	cur Config
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
	s.mu.Unlock()
	return nil
}
