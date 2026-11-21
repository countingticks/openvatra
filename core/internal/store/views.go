package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/countingticks/openvatra/core/internal/event"
)

// ChatRow is one row of the chats view. Times are Unix ms; ActiveRun and ActiveState are "" when no run is open.
type ChatRow struct {
	ID, Title, TitleSource, Model, Profile string
	CreatedAt, UpdatedAt                   int64
	ActiveRun, ActiveState                 string
	LastSeq                                int64
}

// RunRow is one row of the runs view. FinishedAt is 0 while the run is open.
type RunRow struct {
	ID, ChatID, Profile, Model, State, Origin string
	FirstSeq, LastSeq, CreatedAt              int64
	FinishedAt                                int64
	ErrorCode, ErrorMessage                   string
}

// MessageRow is one row of the messages view; Seq is the seq of the event that made it.
type MessageRow struct {
	Seq                        int64
	ChatID, RunID, Role        string
	Parts                      json.RawMessage
	Stats                      json.RawMessage
	Partial, Failed, Retracted bool
	CreatedAt                  int64
}

// RequestRef is the run a client request id made or fed.
type RequestRef struct{ RunID, ChatID string }

const chatColumns = `id, title, title_source, model, profile, created_at, updated_at, COALESCE(active_run, ''),
	COALESCE(active_state, ''), last_seq`

const runColumns = `id, chat_id, profile, model, state, origin, first_seq, last_seq, created_at,
	COALESCE(finished_at, 0), COALESCE(error_code, ''), COALESCE(error_message, '')`

type rowScanner interface{ Scan(dest ...any) error }

func scanChat(r rowScanner) (ChatRow, error) {
	var c ChatRow
	err := r.Scan(&c.ID, &c.Title, &c.TitleSource, &c.Model, &c.Profile, &c.CreatedAt, &c.UpdatedAt, &c.ActiveRun,
		&c.ActiveState, &c.LastSeq)
	return c, err
}

func scanRun(r rowScanner) (RunRow, error) {
	var x RunRow
	err := r.Scan(&x.ID, &x.ChatID, &x.Profile, &x.Model, &x.State, &x.Origin, &x.FirstSeq, &x.LastSeq, &x.CreatedAt,
		&x.FinishedAt, &x.ErrorCode, &x.ErrorMessage)
	return x, err
}

// querier is what both *sql.DB and *sql.Tx offer for a many-row query.
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// queryAll runs query and reads every row with scan.
func queryAll[T any](ctx context.Context, q querier, scan func(rowScanner) (T, error), query string, args ...any) ([]T, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// readAtHead runs read in one read transaction after reading the log's head, so what read sees is current as of at
// least that seq.
func (s *Store) readAtHead(ctx context.Context, read func(tx *sql.Tx) error) (int64, error) {
	tx, err := s.reader().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	head, err := logHead(ctx, tx)
	if err != nil {
		return 0, err
	}
	if err := read(tx); err != nil {
		return 0, err
	}
	return head, nil
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// Chats lists the chats that have at least one message, most recently updated first.
func (s *Store) Chats(ctx context.Context) (rows []ChatRow, seq int64, err error) {
	seq, err = s.readAtHead(ctx, func(tx *sql.Tx) error {
		rows, err = queryAll(ctx, tx, scanChat, `SELECT `+chatColumns+` FROM chats
			WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = chats.id)
			ORDER BY updated_at DESC, rowid DESC`)
		return err
	})
	if err != nil {
		return nil, 0, fmt.Errorf("chats: %w", err)
	}
	return rows, seq, nil
}

// Chat returns one chat, or ErrNotFound.
func (s *Store) Chat(ctx context.Context, id string) (ChatRow, int64, error) {
	var c ChatRow
	seq, err := s.readAtHead(ctx, func(tx *sql.Tx) (err error) {
		c, err = scanChat(tx.QueryRowContext(ctx, `SELECT `+chatColumns+` FROM chats WHERE id = ?`, id))
		return notFound(err)
	})
	return c, seq, err
}

// Transcript returns a chat's messages by seq and its runs by first seq, both oldest first, or ErrNotFound.
func (s *Store) Transcript(ctx context.Context, chatID string) (msgs []MessageRow, runs []RunRow, seq int64, err error) {
	seq, err = s.readAtHead(ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM chats WHERE id = ?)`, chatID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		msgs, err = queryAll(ctx, tx, scanMessage, `SELECT seq, chat_id, run_id, role, parts, stats, partial, failed,
				retracted, created_at FROM messages WHERE chat_id = ? ORDER BY seq`, chatID)
		if err != nil {
			return err
		}
		runs, err = queryAll(ctx, tx, scanRun, `SELECT `+runColumns+` FROM runs WHERE chat_id = ? ORDER BY first_seq`,
			chatID)
		return err
	})
	if err != nil {
		return nil, nil, 0, err
	}
	return msgs, runs, seq, nil
}

func scanMessage(r rowScanner) (MessageRow, error) {
	var m MessageRow
	var parts, stats string
	err := r.Scan(&m.Seq, &m.ChatID, &m.RunID, &m.Role, &parts, &stats, &m.Partial, &m.Failed, &m.Retracted,
		&m.CreatedAt)
	m.Parts, m.Stats = json.RawMessage(parts), json.RawMessage(stats)
	return m, err
}

// Run returns one run, or ErrNotFound.
func (s *Store) Run(ctx context.Context, id string) (RunRow, int64, error) {
	var x RunRow
	seq, err := s.readAtHead(ctx, func(tx *sql.Tx) (err error) {
		x, err = scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id = ?`, id))
		return notFound(err)
	})
	return x, seq, err
}

// OpenRuns returns the runs that are queued or running, oldest first: the ones a starting core must pick up.
func (s *Store) OpenRuns(ctx context.Context) ([]RunRow, error) {
	return queryAll(ctx, s.reader(), scanRun, `SELECT `+runColumns+` FROM runs
		WHERE state IN ('queued', 'running') ORDER BY first_seq`)
}

// Request returns the run a client request id belongs to; ok is false for an unknown id.
func (s *Store) Request(ctx context.Context, requestID string) (ref RequestRef, ok bool, err error) {
	err = s.reader().QueryRowContext(ctx, `SELECT run_id, chat_id FROM requests WHERE request_id = ?`, requestID).
		Scan(&ref.RunID, &ref.ChatID)
	if errors.Is(err, sql.ErrNoRows) {
		return RequestRef{}, false, nil
	}
	if err != nil {
		return RequestRef{}, false, err
	}
	return ref, true, nil
}

// DeleteChat deletes a chat's events, those of its runs and its rows in every view, then appends chat.deleted on
// system, all in one transaction. A missing chat is ErrNotFound and writes nothing.
func (s *Store) DeleteChat(ctx context.Context, chatID string) error {
	if s.readOnly != nil {
		return ErrReadOnly
	}
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	defer tx.Rollback()

	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM chats WHERE id = ?)`, chatID).Scan(&exists); err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	if !exists {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM events WHERE stream = ?
		OR stream IN (SELECT 'run:' || id FROM runs WHERE chat_id = ?)`, "chat:"+chatID, chatID); err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	// runs, messages and requests go with it (ON DELETE CASCADE).
	if _, err := tx.ExecContext(ctx, `DELETE FROM chats WHERE id = ?`, chatID); err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	events, err := s.appendTx(ctx, tx, "system", []event.Payload{event.ChatDeleted{ChatID: chatID}})
	if err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("delete chat: %w", err)
	}
	s.bus.Publish(events...)
	return nil
}

// chatViews keeps the chats, runs, messages and requests tables in step with the chat and run streams. It runs
// inside the append's transaction, so a view is never ahead of or behind the log. An event for a chat or run that
// has no row (deleted, or replayed out of order) changes nothing: deleting a chat must never make a later append of
// that chat's run fail.
type chatViews struct{}

func (chatViews) Apply(tx *sql.Tx, e event.Event) error {
	kind, id, _ := strings.Cut(e.Stream, ":")
	switch kind {
	case "chat":
		return applyChatEvent(tx, id, e)
	case "run":
		return applyRunEvent(tx, id, e)
	}
	return nil
}

func decode[T any](e event.Event) (T, error) {
	var p T
	if err := json.Unmarshal(e.Data, &p); err != nil {
		return p, fmt.Errorf("decode %s: %w", e.Type, err)
	}
	return p, nil
}

func textParts(text string) string {
	b, _ := json.Marshal([]event.MessagePart{{Kind: "text", Text: text}})
	return string(b)
}

func applyChatEvent(tx *sql.Tx, chatID string, e event.Event) error {
	var err error
	switch e.Type {
	case "chat.created":
		p, derr := decode[event.ChatCreated](e)
		if derr != nil {
			return derr
		}
		_, err = tx.Exec(`INSERT OR IGNORE INTO chats (id, model, profile, created_at, updated_at, last_seq)
			VALUES (?, ?, ?, ?, ?, ?)`, chatID, p.Model, p.Profile, e.Time, e.Time, e.Seq)
	case "chat.model":
		p, derr := decode[event.ChatModel](e)
		if derr != nil {
			return derr
		}
		_, err = tx.Exec(`UPDATE chats SET model = ? WHERE id = ?`, p.Model, chatID)
	case "chat.titled":
		p, derr := decode[event.ChatTitled](e)
		if derr != nil {
			return derr
		}
		_, err = tx.Exec(`UPDATE chats SET title = ?, title_source = ?
			WHERE id = ? AND NOT (title_source = 'user' AND ? = 'auto')`, p.Title, p.Source, chatID, p.Source)
	case "turn.retracted":
		p, derr := decode[event.TurnRetracted](e)
		if derr != nil {
			return derr
		}
		_, err = tx.Exec(`UPDATE messages SET retracted = 1 WHERE chat_id = ? AND run_id = ?`, chatID, p.RunID)
	default:
		return nil
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE chats SET last_seq = ? WHERE id = ?`, e.Seq, chatID)
	return err
}

// runEvent is the part every run payload shares: the chat it belongs to.
type runEvent struct {
	ChatID string `json:"chatId"`
}

func applyRunEvent(tx *sql.Tx, runID string, e event.Event) error {
	switch e.Type {
	case "run.queued", "input.received", "run.started", "run.paused", "run.resumed", "run.finished",
		"message.completed", "compaction.completed":
	default:
		return nil
	}
	head, err := decode[runEvent](e)
	if err != nil {
		return err
	}
	chatID := head.ChatID

	if e.Type == "run.queued" {
		return applyRunQueued(tx, runID, e)
	}
	var known bool
	if err := tx.QueryRow(`SELECT EXISTS (SELECT 1 FROM runs WHERE id = ? AND chat_id = ?)`, runID, chatID).
		Scan(&known); err != nil || !known {
		return err
	}

	switch e.Type {
	case "input.received":
		err = applyInput(tx, runID, e)
	case "run.started":
		err = setRunState(tx, runID, chatID, "running")
	case "run.paused":
		err = setRunState(tx, runID, chatID, "interrupted")
	case "run.resumed":
		err = setRunState(tx, runID, chatID, "queued")
	case "run.finished":
		err = applyRunFinished(tx, runID, e)
	case "message.completed":
		err = applyMessageCompleted(tx, runID, e)
	case "compaction.completed":
		var p event.CompactionCompleted
		if p, err = decode[event.CompactionCompleted](e); err == nil {
			_, err = tx.Exec(`INSERT INTO messages (seq, chat_id, run_id, role, parts, created_at)
				VALUES (?, ?, ?, 'summary', ?, ?)`, e.Seq, chatID, runID, textParts(p.Summary), e.Time)
		}
	}
	if err != nil {
		return err
	}
	return touchSeq(tx, runID, chatID, e.Seq)
}

func touchSeq(tx *sql.Tx, runID, chatID string, seq int64) error {
	if _, err := tx.Exec(`UPDATE runs SET last_seq = ? WHERE id = ?`, seq, runID); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE chats SET last_seq = ? WHERE id = ?`, seq, chatID)
	return err
}

func applyRunQueued(tx *sql.Tx, runID string, e event.Event) error {
	p, err := decode[event.RunQueued](e)
	if err != nil {
		return err
	}
	res, err := tx.Exec(`INSERT OR IGNORE INTO runs (id, chat_id, profile, model, state, origin, first_seq, last_seq,
			created_at)
		SELECT ?, ?, ?, ?, 'queued', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chats WHERE id = ?)`,
		runID, p.ChatID, p.Profile, p.Model, p.Origin, e.Seq, e.Seq, e.Time, p.ChatID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	if _, err := tx.Exec(`UPDATE chats SET active_run = ?, active_state = 'queued', last_seq = ? WHERE id = ?`,
		runID, e.Seq, p.ChatID); err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT OR IGNORE INTO requests (request_id, run_id, chat_id) VALUES (?, ?, ?)`,
		p.RequestID, runID, p.ChatID)
	return err
}

func applyInput(tx *sql.Tx, runID string, e event.Event) error {
	p, err := decode[event.InputReceived](e)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO messages (seq, chat_id, run_id, role, parts, created_at)
		VALUES (?, ?, ?, 'user', ?, ?)`, e.Seq, p.ChatID, runID, textParts(p.Text), e.Time); err != nil {
		return err
	}
	// A new run's first input repeats its run's request id, which run.queued already mapped.
	if _, err := tx.Exec(`INSERT OR IGNORE INTO requests (request_id, run_id, chat_id) VALUES (?, ?, ?)`,
		p.RequestID, runID, p.ChatID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE chats SET title = ? WHERE id = ? AND title = ''`, CutTitle(p.Text), p.ChatID); err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE chats SET updated_at = ? WHERE id = ?`, e.Time, p.ChatID)
	return err
}

func setRunState(tx *sql.Tx, runID, chatID, state string) error {
	if _, err := tx.Exec(`UPDATE runs SET state = ? WHERE id = ?`, state, runID); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE chats SET active_state = ? WHERE id = ? AND active_run = ?`, state, chatID, runID)
	return err
}

func applyRunFinished(tx *sql.Tx, runID string, e event.Event) error {
	p, err := decode[event.RunFinished](e)
	if err != nil {
		return err
	}
	var code, msg any // NULL unless the run failed with an error
	if p.Error != nil {
		code, msg = p.Error.Code, p.Error.Message
	}
	if _, err := tx.Exec(`UPDATE runs SET state = ?, finished_at = ?, error_code = ?, error_message = ? WHERE id = ?`,
		p.State, e.Time, code, msg, runID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE chats SET active_run = NULL, active_state = NULL WHERE id = ? AND active_run = ?`,
		p.ChatID, runID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE chats SET updated_at = ? WHERE id = ?`, e.Time, p.ChatID); err != nil {
		return err
	}
	if p.State != "failed" {
		return nil
	}
	_, err = tx.Exec(`UPDATE messages SET failed = 1 WHERE seq =
		(SELECT max(seq) FROM messages WHERE run_id = ? AND role = 'assistant')`, runID)
	return err
}

func applyMessageCompleted(tx *sql.Tx, runID string, e event.Event) error {
	p, err := decode[event.MessageCompleted](e)
	if err != nil {
		return err
	}
	if p.Parts == nil {
		p.Parts = []event.MessagePart{}
	}
	parts, err := json.Marshal(p.Parts)
	if err != nil {
		return err
	}
	stats, err := json.Marshal(p.Stats)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO messages (seq, chat_id, run_id, role, parts, stats, partial, created_at)
		VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)`, e.Seq, p.ChatID, runID, string(parts), string(stats), p.Partial, e.Time)
	return err
}
