package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/countingticks/openvatra/core/internal/event"
)

// ErrConflict means the stored revision differs from the one the caller based its change on.
var ErrConflict = errors.New("revision conflict")

// ErrReadOnly means the database is newer than this version and must not be written.
var ErrReadOnly = errors.New("database is read-only")

// ConfigGet returns a section's revision and JSON; (0, nil, nil) when it was never written.
func (s *Store) ConfigGet(ctx context.Context, section string) (rev int, value []byte, err error) {
	var text string
	err = s.reader().QueryRowContext(ctx, "SELECT rev, value FROM config WHERE section = ?", section).Scan(&rev, &text)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, fmt.Errorf("config get: %w", err)
	}
	return rev, []byte(text), nil
}

// ConfigPut stores value if the section is still at expectRev (absent counts as 0), and returns the new revision.
// The bytes are stored as given; validating them is the config package's job. The same commit appends
// config.changed on the system stream, published once the commit succeeded.
func (s *Store) ConfigPut(ctx context.Context, section string, expectRev int, value []byte) (newRev int, err error) {
	if s.readOnly != nil {
		return 0, ErrReadOnly
	}
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("config put: %w", err)
	}
	defer tx.Rollback()

	var cur int
	err = tx.QueryRowContext(ctx, "SELECT rev FROM config WHERE section = ?", section).Scan(&cur)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("config put: %w", err)
	}
	if cur != expectRev {
		return 0, ErrConflict
	}
	newRev = cur + 1
	if cur == 0 {
		_, err = tx.ExecContext(ctx, "INSERT INTO config (section, rev, value) VALUES (?, 1, ?)", section, string(value))
	} else {
		_, err = tx.ExecContext(ctx, "UPDATE config SET rev = rev + 1, value = ? WHERE section = ?", string(value), section)
	}
	if err != nil {
		return 0, fmt.Errorf("config put: %w", err)
	}
	events, err := s.appendTx(ctx, tx, "system", []event.Payload{event.ConfigChanged{Section: section, Rev: newRev}})
	if err != nil {
		return 0, fmt.Errorf("config put: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("config put: %w", err)
	}
	s.bus.Publish(events...)
	return newRev, nil
}
