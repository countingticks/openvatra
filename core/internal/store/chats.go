package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// ErrNotFound is returned when a chat or message id doesn't exist.
var ErrNotFound = errors.New("not found")

// Title sources: who chose the title. A title the user typed is never replaced by a generated one.
const (
	TitleAuto = "auto"
	TitleUser = "user"
)

// Message roles and statuses, as stored.
const (
	RoleUser      = "user"
	RoleAssistant = "assistant"

	StatusDone    = "done"
	StatusStopped = "stopped" // the user pressed Stop; content is the partial answer
	StatusError   = "error"
)

// titleLength is how long the title cut from the first message may be, in characters.
const titleLength = 50

// Chat is one conversation. Times are Unix milliseconds.
type Chat struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	TitleSource string          `json:"titleSource"`
	Model       string          `json:"model"`
	CreatedAt   int64           `json:"createdAt"`
	UpdatedAt   int64           `json:"updatedAt"`
	WebSearch   bool            `json:"webSearch"`
	Settings    json.RawMessage `json:"settings"`
}

// Message is one turn. Stats holds token counts and timings as JSON (see SPEC-chat.md).
type Message struct {
	ID        string          `json:"id"`
	ChatID    string          `json:"chatId"`
	Role      string          `json:"role"`
	Content   string          `json:"content"`
	Reasoning string          `json:"reasoning"`
	Status    string          `json:"status"`
	Error     string          `json:"error"`
	Model     string          `json:"model"`
	Stats     json.RawMessage `json:"stats"`
	CreatedAt int64           `json:"createdAt"`
}

// ChatUpdate lists the fields a PATCH may change; nil means "leave as is".
type ChatUpdate struct {
	Title     *string
	Model     *string
	WebSearch *bool
}

// MessageUpdate is what a finished (or stopped, or failed) answer writes back into its message.
type MessageUpdate struct {
	Content   string
	Reasoning string
	Status    string
	Error     string
	Stats     json.RawMessage
}

// NewID returns a random UUID v4. Random ids reveal nothing about how many chats exist (unlike 1, 2, 3...).
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failing means the OS is broken; nothing sensible to do
	}
	b[6] = b[6]&0x0f | 0x40 // version 4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// CutTitle makes a temporary title from the first message: whitespace collapsed, cut at a word boundary to about
// titleLength characters, with an ellipsis when something was cut.
func CutTitle(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= titleLength {
		return text
	}
	cut := string([]rune(text)[:titleLength])
	// Prefer the last space, unless that would throw away most of the title (one very long word).
	if i := strings.LastIndex(cut, " "); i >= titleLength/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " .,;:!?-") + "…"
}

func (s *Store) nowMillis() int64 {
	if s.now != nil {
		return s.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

// CreateChat starts an empty chat with no title yet; the first message gives it one.
func (s *Store) CreateChat(ctx context.Context, model string, webSearch bool) (Chat, error) {
	now := s.nowMillis()
	c := Chat{
		ID: NewID(), TitleSource: TitleAuto, Model: model, CreatedAt: now, UpdatedAt: now,
		WebSearch: webSearch, Settings: json.RawMessage("{}"),
	}
	_, err := s.writer().ExecContext(ctx,
		`INSERT INTO chats (id, title, title_source, model, created_at, updated_at, web_search, settings)
		 VALUES (?, '', ?, ?, ?, ?, ?, '{}')`,
		c.ID, c.TitleSource, c.Model, now, now, webSearch)
	if err != nil {
		return Chat{}, fmt.Errorf("create chat: %w", err)
	}
	return c, nil
}

const chatColumns = `id, title, title_source, model, created_at, updated_at, web_search, settings`

// rowScanner is what both *sql.Row and *sql.Rows offer, so one function reads either.
type rowScanner interface{ Scan(dest ...any) error }

func scanChat(r rowScanner) (Chat, error) {
	var c Chat
	var settings string
	err := r.Scan(&c.ID, &c.Title, &c.TitleSource, &c.Model, &c.CreatedAt, &c.UpdatedAt, &c.WebSearch, &settings)
	c.Settings = json.RawMessage(settings)
	return c, err
}

// GetChat returns one chat, or ErrNotFound.
func (s *Store) GetChat(ctx context.Context, id string) (Chat, error) {
	c, err := scanChat(s.reader().QueryRowContext(ctx, `SELECT `+chatColumns+` FROM chats WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Chat{}, ErrNotFound
	}
	return c, err
}

// ListChats returns every chat, most recently updated first. Chats with no messages yet are left out: a "New chat"
// the user never typed into shouldn't clutter the history.
func (s *Store) ListChats(ctx context.Context) ([]Chat, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+chatColumns+` FROM chats
		 WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = chats.id)
		 ORDER BY updated_at DESC, rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	chats := []Chat{}
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		chats = append(chats, c)
	}
	return chats, rows.Err()
}

// UpdateChat applies the non-nil fields. Setting a title marks it as the user's own.
func (s *Store) UpdateChat(ctx context.Context, id string, u ChatUpdate) (Chat, error) {
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return Chat{}, err
	}
	defer tx.Rollback() // no-op after a successful Commit
	// Each field is its own statement: simple to read, and the transaction makes them land together.
	steps := []struct {
		set  bool
		sql  string
		args []any
	}{
		{u.Title != nil, `UPDATE chats SET title = ?, title_source = 'user' WHERE id = ?`, nil},
		{u.Model != nil, `UPDATE chats SET model = ? WHERE id = ?`, nil},
		{u.WebSearch != nil, `UPDATE chats SET web_search = ? WHERE id = ?`, nil},
	}
	if u.Title != nil {
		steps[0].args = []any{strings.TrimSpace(*u.Title), id}
	}
	if u.Model != nil {
		steps[1].args = []any{*u.Model, id}
	}
	if u.WebSearch != nil {
		steps[2].args = []any{*u.WebSearch, id}
	}
	for _, st := range steps {
		if !st.set {
			continue
		}
		res, err := tx.ExecContext(ctx, st.sql, st.args...)
		if err != nil {
			return Chat{}, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return Chat{}, ErrNotFound
		}
	}
	if err := tx.Commit(); err != nil {
		return Chat{}, err
	}
	return s.GetChat(ctx, id) // committed, so the read pool sees it (WAL)
}

// SetAutoTitle stores a generated title, unless the user has set their own in the meantime.
func (s *Store) SetAutoTitle(ctx context.Context, id, title string) error {
	_, err := s.writer().ExecContext(ctx,
		`UPDATE chats SET title = ? WHERE id = ? AND title_source = 'auto'`, strings.TrimSpace(title), id)
	return err
}

// DeleteChat removes a chat; its messages go with it (ON DELETE CASCADE).
func (s *Store) DeleteChat(ctx context.Context, id string) error {
	res, err := s.writer().ExecContext(ctx, `DELETE FROM chats WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// AddMessage appends a message to a chat and bumps the chat's updated time. If it is the chat's first message and
// the chat has no title yet, the title is cut from it. All in one transaction: a message never exists without the
// chat's time and title matching.
func (s *Store) AddMessage(ctx context.Context, m Message) (Message, error) {
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()

	now := s.nowMillis()
	m.ID, m.CreatedAt = NewID(), now
	if m.Status == "" {
		m.Status = StatusDone
	}
	if len(m.Stats) == 0 {
		m.Stats = json.RawMessage("{}")
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO messages (id, chat_id, role, content, reasoning, status, error, model, stats, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.ChatID, m.Role, m.Content, m.Reasoning, m.Status, m.Error, m.Model, string(m.Stats), now); err != nil {
		// A missing chat shows up as a failed foreign key; report it the way the other functions do.
		if strings.Contains(err.Error(), "FOREIGN KEY") {
			return Message{}, ErrNotFound
		}
		return Message{}, fmt.Errorf("add message: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chats SET updated_at = ? WHERE id = ?`, now, m.ChatID); err != nil {
		return Message{}, err
	}
	if m.Role == RoleUser {
		if _, err := tx.ExecContext(ctx,
			`UPDATE chats SET title = ? WHERE id = ? AND title = '' AND title_source = 'auto'`,
			CutTitle(m.Content), m.ChatID); err != nil {
			return Message{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return m, nil
}

// UpdateMessage writes the final state of an answer (done, stopped or failed) and bumps the chat's updated time.
func (s *Store) UpdateMessage(ctx context.Context, id string, u MessageUpdate) error {
	if len(u.Stats) == 0 {
		u.Stats = json.RawMessage("{}")
	}
	tx, err := s.writer().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`UPDATE messages SET content = ?, reasoning = ?, status = ?, error = ?, stats = ? WHERE id = ?`,
		u.Content, u.Reasoning, u.Status, u.Error, string(u.Stats), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE chats SET updated_at = ? WHERE id = (SELECT chat_id FROM messages WHERE id = ?)`,
		s.nowMillis(), id); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteMessage removes one message (regenerate and edit-last replace the old answer).
func (s *Store) DeleteMessage(ctx context.Context, id string) error {
	res, err := s.writer().ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Messages returns a chat's messages, oldest first. rowid breaks ties between messages made in the same millisecond.
func (s *Store) Messages(ctx context.Context, chatID string) ([]Message, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT id, chat_id, role, content, reasoning, status, error, model, stats, created_at
		 FROM messages WHERE chat_id = ? ORDER BY created_at, rowid`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	msgs := []Message{}
	for rows.Next() {
		var m Message
		var stats string
		if err := rows.Scan(&m.ID, &m.ChatID, &m.Role, &m.Content, &m.Reasoning, &m.Status, &m.Error, &m.Model,
			&stats, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.Stats = json.RawMessage(stats)
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}
