package config

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
)

// The section names of the old models section and its two owners. config cannot import the owners
// (engine/llamaserver, provider/llamacpp); main_test.go proves these names and the JSON below match theirs.
const (
	legacySection   = "models"
	engineSection   = "engine.llamaserver"
	providerSection = "provider.llamacpp"
)

// legacyModels is the models section as versions before the split stored it.
type legacyModels struct {
	LlamaServerPath   *string                    `json:"llamaServerPath"`
	ModelsDir         *string                    `json:"modelsDir"`
	EmbeddingModel    *string                    `json:"embeddingModel"`
	IdleUnloadMinutes *int                       `json:"idleUnloadMinutes"`
	Options           map[string]legacyModelArgs `json:"options"`
	Engine            string                     `json:"engine"`
}

type legacyModelArgs struct {
	Args string `json:"args,omitempty"`
}

type splitEngine struct {
	Path  *string `json:"path"`
	Build string  `json:"build"`
}

type splitProvider struct {
	ModelsDir         *string                    `json:"modelsDir"`
	EmbeddingModel    *string                    `json:"embeddingModel"`
	IdleUnloadMinutes *int                       `json:"idleUnloadMinutes"`
	Options           map[string]legacyModelArgs `json:"options"`
}

// SplitModels moves a stored models section into engine.llamaserver and provider.llamacpp, once, before any
// Register. The old row is decoded strictly but not validated: each owner validates its half at Register, so one bad
// field resets only its own section. A row that does not decode is deleted and both sections start from their
// defaults. Without a models row (a fresh install, or already split) it does nothing.
func SplitModels(ctx context.Context, db DB, logger *slog.Logger) error {
	if db == nil {
		return nil
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	_, data, err := db.ConfigGet(ctx, legacySection)
	if err != nil {
		return fmt.Errorf("split models: %w", err)
	}
	if data == nil {
		return nil
	}
	var old legacyModels
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&old); err != nil {
		if _, err := db.ConfigMove(ctx, legacySection, nil); err != nil {
			return fmt.Errorf("split models: %w", err)
		}
		logger.Error("stored models section is invalid; both new sections start from their defaults", "err", err)
		return nil
	}
	build := old.Engine
	if build == "bundled" {
		build = "auto" // the default before migration 0009 turned it into auto
	}
	engine, err := json.Marshal(splitEngine{Path: old.LlamaServerPath, Build: build})
	if err != nil {
		return fmt.Errorf("split models: %w", err)
	}
	provider, err := json.Marshal(splitProvider{
		ModelsDir:         old.ModelsDir,
		EmbeddingModel:    old.EmbeddingModel,
		IdleUnloadMinutes: old.IdleUnloadMinutes,
		Options:           old.Options,
	})
	if err != nil {
		return fmt.Errorf("split models: %w", err)
	}
	moved, err := db.ConfigMove(ctx, legacySection, map[string][]byte{engineSection: engine, providerSection: provider})
	if err != nil {
		return fmt.Errorf("split models: %w", err)
	}
	if moved {
		logger.Info("split the models config section into engine.llamaserver and provider.llamacpp")
	} else {
		logger.Warn("dropped the models config section; the new sections already exist")
	}
	return nil
}
