package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"

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

// ConfigMove replaces section from with the sections in to, in one transaction. The new sections are written at
// rev 1 only when none of them exists yet (moved is true); otherwise, or when to is empty, from is just deleted, so
// sections written by a newer version win. Each new section gets a config.changed, in name order.
func (s *Store) ConfigMove(ctx context.Context, from string, to map[string][]byte) (moved bool, err error) {
	if s.readOnly != nil {
		return false, ErrReadOnly
	}
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("config move: %w", err)
	}
	defer tx.Rollback()

	exists := func(section string) (bool, error) {
		var n int
		err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM config WHERE section = ?", section).Scan(&n)
		return n > 0, err
	}
	found, err := exists(from)
	if err != nil {
		return false, fmt.Errorf("config move: %w", err)
	}
	if !found {
		return false, nil
	}
	names := make([]string, 0, len(to))
	for name := range to {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		taken, err := exists(name)
		if err != nil {
			return false, fmt.Errorf("config move: %w", err)
		}
		if taken {
			names = nil
			break
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM config WHERE section = ?", from); err != nil {
		return false, fmt.Errorf("config move: %w", err)
	}
	payloads := make([]event.Payload, 0, len(names))
	for _, name := range names {
		if _, err := tx.ExecContext(ctx, "INSERT INTO config (section, rev, value) VALUES (?, 1, ?)", name, string(to[name])); err != nil {
			return false, fmt.Errorf("config move: %w", err)
		}
		payloads = append(payloads, event.ConfigChanged{Section: name, Rev: 1})
	}
	var events []event.Event
	if len(payloads) > 0 {
		if events, err = s.appendTx(ctx, tx, "system", payloads); err != nil {
			return false, fmt.Errorf("config move: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("config move: %w", err)
	}
	s.bus.Publish(events...)
	return len(names) > 0, nil
}
