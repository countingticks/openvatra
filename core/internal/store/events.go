package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

const maxReadLimit = 1000

// storeLog is the store's event log. Publish and Subscribe come from the embedded MemoryLog; Append, Read and Info
// use the events table.
type storeLog struct {
	event.Log
	s *Store
}

// Log is the event log kept in this database.
func (s *Store) Log() event.Log {
	return storeLog{Log: event.MemoryLog(s.bus), s: s}
}

// AddProjector registers p to run on every appended event, inside the append's transaction, after those added
// before it.
func (s *Store) AddProjector(p event.Projector) {
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	s.projectors = append(s.projectors, p)
}

func (s *Store) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// checkDurable panics unless every payload is durable: only those are stored.
func checkDurable(payloads []event.Payload) {
	for _, p := range payloads {
		if t := p.EventType(); t.Class != event.Durable {
			panic(fmt.Sprintf("store: append of non-durable %q", t.Name))
		}
	}
}

// appendTx inserts the payloads as events on stream and runs the projectors on each. The caller holds appendMu,
// commits, and publishes the returned events only after the commit succeeds; on an error it rolls back.
func (s *Store) appendTx(ctx context.Context, tx *sql.Tx, stream string, payloads []event.Payload) ([]event.Event, error) {
	checkDurable(payloads)
	now := s.clock()
	events := make([]event.Event, 0, len(payloads))
	for _, p := range payloads {
		e := event.New(stream, p, now)
		res, err := tx.ExecContext(ctx, "INSERT INTO events (time, stream, type, v, data) VALUES (?, ?, ?, ?, ?)",
			e.Time, e.Stream, e.Type, e.V, string(e.Data))
		if err != nil {
			return nil, err
		}
		if e.Seq, err = res.LastInsertId(); err != nil {
			return nil, err
		}
		for _, pr := range s.projectors {
			if err := pr.Apply(tx, e); err != nil {
				return nil, fmt.Errorf("project %s: %w", e.Type, err)
			}
		}
		events = append(events, e)
	}
	return events, nil
}

func (l storeLog) Append(ctx context.Context, stream string, payloads ...event.Payload) ([]event.Event, error) {
	checkDurable(payloads)
	if len(payloads) == 0 {
		return nil, nil
	}
	s := l.s
	if s.readOnly != nil {
		return nil, event.ErrUnavailable
	}
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	events, err := s.commitEvents(ctx, stream, payloads)
	if err != nil {
		return nil, fmt.Errorf("event append: %w", err)
	}
	s.bus.Publish(events...)
	return events, nil
}

func (s *Store) commitEvents(ctx context.Context, stream string, payloads []event.Payload) ([]event.Event, error) {
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	events, err := s.appendTx(ctx, tx, stream, payloads)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return events, nil
}

func (l storeLog) Read(ctx context.Context, after int64, f event.Filter, limit int) ([]event.Event, error) {
	if limit < 1 || limit > maxReadLimit {
		panic(fmt.Sprintf("store: Read limit %d outside 1–%d", limit, maxReadLimit))
	}
	q := "SELECT seq, time, stream, type, v, data FROM events WHERE seq > ?"
	args := []any{after}
	if len(f.Streams) > 0 {
		var conds, exact []string
		for _, item := range f.Streams {
			if kind, ok := strings.CutSuffix(item, ":*"); ok {
				// kind is [a-z]+ (ParseFilter), so it holds no LIKE wildcards.
				conds = append(conds, "stream LIKE ?")
				args = append(args, kind+":%")
			} else {
				exact = append(exact, "?")
				args = append(args, item)
			}
		}
		if len(exact) > 0 {
			conds = append(conds, "stream IN ("+strings.Join(exact, ", ")+")")
		}
		q += " AND (" + strings.Join(conds, " OR ") + ")"
	}
	q += " ORDER BY seq LIMIT ?"
	args = append(args, limit)

	rows, err := l.s.reader().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("event read: %w", err)
	}
	defer rows.Close()
	events := []event.Event{}
	for rows.Next() {
		var e event.Event
		var data string
		if err := rows.Scan(&e.Seq, &e.Time, &e.Stream, &e.Type, &e.V, &data); err != nil {
			return nil, fmt.Errorf("event read: %w", err)
		}
		e.Data = []byte(data)
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("event read: %w", err)
	}
	return events, nil
}

func (l storeLog) Info(ctx context.Context) (event.Info, error) {
	var info event.Info
	r := l.s.reader()
	if err := r.QueryRowContext(ctx, "SELECT id FROM log_info").Scan(&info.ID); err != nil {
		return event.Info{}, fmt.Errorf("event info: %w", err)
	}
	// sqlite_sequence keeps the highest seq ever given, so trimming never lowers the head.
	err := r.QueryRowContext(ctx, "SELECT seq FROM sqlite_sequence WHERE name = 'events'").Scan(&info.Head)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return event.Info{}, fmt.Errorf("event info: %w", err)
	}
	return info, nil
}

// TrimSystem deletes system events older than before and returns how many went. Other streams are never trimmed.
func (s *Store) TrimSystem(ctx context.Context, before time.Time) (int64, error) {
	if s.readOnly != nil {
		return 0, ErrReadOnly
	}
	res, err := s.writer().ExecContext(ctx, "DELETE FROM events WHERE stream = 'system' AND time < ?", before.UnixMilli())
	if err != nil {
		return 0, fmt.Errorf("trim system events: %w", err)
	}
	return res.RowsAffected()
}
