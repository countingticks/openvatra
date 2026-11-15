package llamacpp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"slices"

	"github.com/countingticks/openvatra/core/internal/config"
)

// UpgradeOptions rewrites, once, stored arguments that carry the size and placement flags core now sets itself
// (config.UpgradeArgs): without it such a text would no longer validate and Register would reset the whole section.
// A flag's size or placement fills the option's field only when that field is not set yet. It runs before Register;
// a missing or undecodable row is left to Register's own rule. A second run changes nothing.
func UpgradeOptions(ctx context.Context, db config.DB, logger *slog.Logger) error {
	if db == nil {
		return nil
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	rev, data, err := db.ConfigGet(ctx, ID)
	if err != nil {
		return fmt.Errorf("upgrade options: %w", err)
	}
	if data == nil {
		return nil
	}
	var s LlamaCppSettings
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return nil
	}

	ids := make([]string, 0, len(s.Options))
	for id := range s.Options {
		ids = append(ids, id)
	}
	slices.Sort(ids) // the log lines come in the same order every time
	changed := false
	for _, id := range ids {
		o := s.Options[id]
		up, err := config.UpgradeArgs(o.Args)
		if err != nil || up.Args == o.Args {
			continue // a text that does not split stays for Validate to report
		}
		o.Args = up.Args
		if o.Context == nil && up.Context > 0 {
			o.Context = &up.Context
		}
		if o.Placement == "" && up.Placement != "" {
			o.Placement = up.Placement
		}
		s.Options[id] = o
		changed = true
		logger.Info("moved size and placement flags out of a model's arguments", "model", id)
		for _, flag := range up.Dropped {
			logger.Warn("dropped a flag core now sets itself from a model's arguments", "model", id, "flag", flag)
		}
	}
	if !changed {
		return nil
	}
	value, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("upgrade options: %w", err)
	}
	if _, err := db.ConfigPut(ctx, ID, rev, value); err != nil {
		return fmt.Errorf("upgrade options: %w", err)
	}
	return nil
}
