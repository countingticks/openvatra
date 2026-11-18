package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// FitModel names a model as it was measured: its id, whether the projector loaded, the user's args (config.JoinArgs)
// and the file's size and time, so a measurement of another file or setup is never mistaken for this one.
type FitModel struct {
	ModelID   string
	Projector bool
	Args      string
	FileBytes int64
	FileMtime time.Time
}

// FitPlace is the size and placement a load used. Layers is 0 unless Placement is "layers".
type FitPlace struct {
	Context   int
	Placement string // gpu, experts, layers, cpu
	Layers    int
}

// ModelFit is what was measured for one place.
type ModelFit struct {
	FitPlace
	Memory              bool // vram/ram were measured
	VRAMBytes, RAMBytes int64
	TokensPerSecond     float64 // 0 = no answer measured
	MeasuredAt          time.Time
}

// RecordFitMemory stores the memory a load of m at p used. The row's speed stays, unless the file changed.
func (s *Store) RecordFitMemory(ctx context.Context, m FitModel, p FitPlace, vram, ram int64) error {
	return s.recordFit(ctx, m, p,
		"vram_bytes, ram_bytes", "?, ?", "vram_bytes = excluded.vram_bytes, ram_bytes = excluded.ram_bytes",
		vram, ram)
}

// RecordFitSpeed stores the speed of answers from m at p. The row's memory stays, unless the file changed.
func (s *Store) RecordFitSpeed(ctx context.Context, m FitModel, p FitPlace, tokensPerSecond float64) error {
	return s.recordFit(ctx, m, p,
		"tokens_per_second", "?", "tokens_per_second = excluded.tokens_per_second", tokensPerSecond)
}

// recordFit upserts the row for (m, p): a row measured on another file is deleted first, so what it measured does not
// outlive the file; otherwise only the given columns change.
func (s *Store) recordFit(ctx context.Context, m FitModel, p FitPlace, columns, marks, updates string, values ...any) error {
	if s.readOnly != nil {
		return ErrReadOnly
	}
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("record fit: %w", err)
	}
	defer tx.Rollback()
	key := []any{m.ModelID, boolInt(m.Projector), m.Args, p.Context, p.Placement, p.Layers}
	const where = " WHERE model_id = ? AND projector = ? AND args = ? AND context = ? AND placement = ? AND layers = ?"
	stale := append(append([]any{}, key...), m.FileBytes, m.FileMtime.UnixNano())
	if _, err := tx.ExecContext(ctx, "DELETE FROM model_fit"+where+" AND (file_bytes <> ? OR file_mtime <> ?)", stale...); err != nil {
		return fmt.Errorf("record fit: %w", err)
	}
	args := append(append(append([]any{}, key...), m.FileBytes, m.FileMtime.UnixNano()), values...)
	args = append(args, s.nowMillis())
	_, err = tx.ExecContext(ctx, `INSERT INTO model_fit
		(model_id, projector, args, context, placement, layers, file_bytes, file_mtime, `+columns+`, measured_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, `+marks+`, ?)
		ON CONFLICT (model_id, projector, args, context, placement, layers)
		DO UPDATE SET `+updates+`, measured_at = excluded.measured_at`, args...)
	if err != nil {
		return fmt.Errorf("record fit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("record fit: %w", err)
	}
	return nil
}

// ModelFits returns what was measured for m: rows of other args, projector or file are left out (and left in the
// table). No order is promised.
func (s *Store) ModelFits(ctx context.Context, m FitModel) ([]ModelFit, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT context, placement, layers, vram_bytes, ram_bytes, tokens_per_second, measured_at
		FROM model_fit WHERE model_id = ? AND projector = ? AND args = ? AND file_bytes = ? AND file_mtime = ?`,
		m.ModelID, boolInt(m.Projector), m.Args, m.FileBytes, m.FileMtime.UnixNano())
	if err != nil {
		return nil, fmt.Errorf("model fits: %w", err)
	}
	defer rows.Close()
	var fits []ModelFit
	for rows.Next() {
		var f ModelFit
		var vram, ram sql.NullInt64
		var speed sql.NullFloat64
		var at int64
		if err := rows.Scan(&f.Context, &f.Placement, &f.Layers, &vram, &ram, &speed, &at); err != nil {
			return nil, fmt.Errorf("model fits: %w", err)
		}
		f.Memory = vram.Valid && ram.Valid
		f.VRAMBytes, f.RAMBytes = vram.Int64, ram.Int64
		f.TokensPerSecond = speed.Float64
		f.MeasuredAt = time.UnixMilli(at)
		fits = append(fits, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("model fits: %w", err)
	}
	return fits, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
