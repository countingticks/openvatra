package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/countingticks/openvatra/core/internal/event"
)

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
