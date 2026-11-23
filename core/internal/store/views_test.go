package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

func appendTo(t *testing.T, s *Store, stream string, ps ...event.Payload) []event.Event {
	t.Helper()
	events, err := s.Log().Append(ctx, stream, ps...)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

// newChat starts a chat whose first run is queued with text as its input; both share one request id.
func newChat(t *testing.T, s *Store, text string) (chatID, runID string) {
	t.Helper()
	chatID, runID = NewID(), NewID()
	appendTo(t, s, "chat:"+chatID, event.ChatCreated{Model: "m1", Profile: "chat"})
	queueRun(t, s, chatID, runID, text)
	return chatID, runID
}

// queueRun opens run runID in chatID with text as its input.
func queueRun(t *testing.T, s *Store, chatID, runID, text string) string {
	t.Helper()
	req := NewID()
	appendTo(t, s, "run:"+runID,
		event.RunQueued{ChatID: chatID, Profile: "chat", Model: "m1", Origin: "user", RequestID: req},
		event.InputReceived{ChatID: chatID, Text: text, RequestID: req})
	return req
}

func answer(chatID, text string, partial bool) event.MessageCompleted {
	return event.MessageCompleted{
		ChatID: chatID, Parts: []event.MessagePart{{Kind: "text", Text: text}}, Partial: partial, Model: "m1",
		Stats: event.MessageStats{PromptTokens: 12, AnswerTokens: 3, Exact: true},
	}
}

// tableRows runs query and prints each row as "[v1 v2 …]", with <nil> for NULL.
func tableRows(t *testing.T, s *Store, query string, args ...any) []string {
	t.Helper()
	rows, err := s.reader().Query(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%v", vals))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// row is the one row query returns.
func row(t *testing.T, s *Store, query string, args ...any) string {
	t.Helper()
	got := tableRows(t, s, query, args...)
	if len(got) != 1 {
		t.Fatalf("%s: %d rows, want 1: %v", query, len(got), got)
	}
	return got[0]
}

var viewTables = []string{"chats", "runs", "messages", "requests"}

func TestChatWithRunAndAnswerHasOneRowPerTableAndTheCutTitle(t *testing.T) {
	s, _ := newEventStore(t)
	text := "Please explain how the Rust borrow checker decides when a reference is still alive in a loop"
	chatID, runID := newChat(t, s, text)
	appendTo(t, s, "run:"+runID, answer(chatID, "It tracks lifetimes.", false), event.RunFinished{ChatID: chatID, State: "done"})

	for table, want := range map[string]int{"chats": 1, "runs": 1, "requests": 1, "messages": 2} {
		if got := len(tableRows(t, s, "SELECT * FROM "+table)); got != want {
			t.Errorf("%s has %d rows, want %d", table, got, want)
		}
	}
	if got := row(t, s, "SELECT title, title_source, model, profile FROM chats"); got != "["+CutTitle(text)+" auto m1 chat]" {
		t.Errorf("chat = %s", got)
	}
	msgs := tableRows(t, s, "SELECT role, run_id, parts, partial, failed, retracted FROM messages ORDER BY seq")
	want := []string{
		fmt.Sprintf(`[user %s [{"kind":"text","text":%q}] 0 0 0]`, runID, text),
		fmt.Sprintf(`[assistant %s [{"kind":"text","text":"It tracks lifetimes."}] 0 0 0]`, runID),
	}
	if !slices.Equal(msgs, want) {
		t.Errorf("messages = %v\nwant %v", msgs, want)
	}
	var stats event.MessageStats
	if err := json.Unmarshal([]byte(strings.Trim(row(t, s, "SELECT stats FROM messages WHERE role = 'assistant'"), "[]")), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.PromptTokens != 12 || stats.AnswerTokens != 3 || !stats.Exact {
		t.Errorf("stats = %+v", stats)
	}
}

func TestRunStatesFollowEventsAndChatActiveFieldsClearOnFinish(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, runID := newChat(t, s, "hi")
	states := func() string {
		return row(t, s, "SELECT r.state, c.active_run, c.active_state FROM runs r JOIN chats c ON c.id = r.chat_id")
	}
	steps := []struct {
		p    event.Payload
		want string
	}{
		{nil, "[queued " + runID + " queued]"},
		{event.RunStarted{ChatID: chatID}, "[running " + runID + " running]"},
		{event.RunPaused{ChatID: chatID, Reason: "interrupted"}, "[interrupted " + runID + " interrupted]"},
		{event.RunResumed{ChatID: chatID}, "[queued " + runID + " queued]"},
		{event.RunStarted{ChatID: chatID}, "[running " + runID + " running]"},
		{event.RunFinished{ChatID: chatID, State: "done"}, "[done <nil> <nil>]"},
	}
	for _, st := range steps {
		if st.p != nil {
			appendTo(t, s, "run:"+runID, st.p)
		}
		if got := states(); got != st.want {
			t.Fatalf("after %v: %s, want %s", st.p, got, st.want)
		}
	}
	finished := row(t, s, "SELECT finished_at IS NOT NULL, last_seq = (SELECT max(seq) FROM events) FROM runs")
	if finished != "[1 1]" {
		t.Errorf("finished_at set, last_seq = head: %s", finished)
	}
}

func TestFailedRunMarksItsPartialAnswerFailedAndStoppedDoesNot(t *testing.T) {
	s, _ := newEventStore(t)
	failedChat, failedRun := newChat(t, s, "one")
	appendTo(t, s, "run:"+failedRun, answer(failedChat, "half", true),
		event.RunFinished{ChatID: failedChat, State: "failed", Error: &event.RunError{Code: "backend_failed", Message: "it broke"}})
	stoppedChat, stoppedRun := newChat(t, s, "two")
	appendTo(t, s, "run:"+stoppedRun, answer(stoppedChat, "half", true), event.RunFinished{ChatID: stoppedChat, State: "stopped"})

	if got := row(t, s, "SELECT partial, failed FROM messages WHERE run_id = ? AND role = 'assistant'", failedRun); got != "[1 1]" {
		t.Errorf("failed run's answer = %s", got)
	}
	if got := row(t, s, "SELECT partial, failed FROM messages WHERE run_id = ? AND role = 'assistant'", stoppedRun); got != "[1 0]" {
		t.Errorf("stopped run's answer = %s", got)
	}
	if got := row(t, s, "SELECT state, error_code, error_message FROM runs WHERE id = ?", failedRun); got != "[failed backend_failed it broke]" {
		t.Errorf("failed run = %s", got)
	}
	if got := row(t, s, "SELECT state, error_code, error_message FROM runs WHERE id = ?", stoppedRun); got != "[stopped <nil> <nil>]" {
		t.Errorf("stopped run = %s", got)
	}
}

func TestFailedRunKeepsAnEarlierCompleteAnswerNotFailed(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, runID := newChat(t, s, "one")
	appendTo(t, s, "run:"+runID, answer(chatID, "full", false),
		event.RunFinished{ChatID: chatID, State: "failed", Error: &event.RunError{Code: "backend_failed", Message: "it broke"}})

	if got := row(t, s, "SELECT partial, failed FROM messages WHERE run_id = ? AND role = 'assistant'", runID); got != "[0 0]" {
		t.Errorf("complete answer of a failed run = %s", got)
	}
}

func TestUserTitleIsNotReplacedByAutoTitleAndAutoReplacesCutOne(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, _ := newChat(t, s, "hello there")
	title := func() string { return row(t, s, "SELECT title, title_source FROM chats") }
	if got := title(); got != "[hello there auto]" {
		t.Fatalf("cut title = %s", got)
	}
	steps := []struct {
		p    event.ChatTitled
		want string
	}{
		{event.ChatTitled{Title: "Greeting", Source: "auto"}, "[Greeting auto]"},
		{event.ChatTitled{Title: "Mine", Source: "user"}, "[Mine user]"},
		{event.ChatTitled{Title: "Later", Source: "auto"}, "[Mine user]"},
	}
	for _, st := range steps {
		appendTo(t, s, "chat:"+chatID, st.p)
		if got := title(); got != st.want {
			t.Errorf("after %+v: %s, want %s", st.p, got, st.want)
		}
	}
}

func TestRetractedRunsMessagesAreMarked(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, first := newChat(t, s, "one")
	appendTo(t, s, "run:"+first, answer(chatID, "a", false), event.RunFinished{ChatID: chatID, State: "done"})
	second := NewID()
	queueRun(t, s, chatID, second, "two")
	appendTo(t, s, "run:"+second, answer(chatID, "b", false), event.RunFinished{ChatID: chatID, State: "done"})

	appendTo(t, s, "chat:"+chatID, event.TurnRetracted{RunID: first})

	got := tableRows(t, s, "SELECT run_id, retracted FROM messages ORDER BY seq")
	want := []string{"[" + first + " 1]", "[" + first + " 1]", "[" + second + " 0]", "[" + second + " 0]"}
	if !slices.Equal(got, want) {
		t.Errorf("messages = %v, want %v", got, want)
	}
}

func TestInputRequestIDAndRunFirstRequestIDMapToRunOnce(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, runID := newChat(t, s, "one")
	first := strings.Fields(strings.Trim(row(t, s, "SELECT request_id FROM requests"), "[]"))[0]
	appendTo(t, s, "run:"+runID, event.InputReceived{ChatID: chatID, Text: "more", RequestID: "later-req"})

	got := tableRows(t, s, "SELECT request_id, run_id, chat_id FROM requests ORDER BY request_id = 'later-req'")
	want := []string{"[" + first + " " + runID + " " + chatID + "]", "[later-req " + runID + " " + chatID + "]"}
	if !slices.Equal(got, want) {
		t.Errorf("requests = %v, want %v", got, want)
	}
}

func TestEventsForUnknownChatChangeNothing(t *testing.T) {
	s, _ := newEventStore(t)
	appendTo(t, s, "chat:ghost", event.ChatModel{Model: "m2"}, event.ChatTitled{Title: "x", Source: "user"},
		event.TurnRetracted{RunID: "r1"})
	appendTo(t, s, "run:r1",
		event.RunQueued{ChatID: "ghost", Profile: "chat", Model: "m1", Origin: "user", RequestID: "q"},
		event.InputReceived{ChatID: "ghost", Text: "hi", RequestID: "q"},
		event.RunStarted{ChatID: "ghost"},
		answer("ghost", "a", false),
		event.CompactionCompleted{ChatID: "ghost", Summary: "s"},
		event.RunFinished{ChatID: "ghost", State: "failed"})

	for _, table := range viewTables {
		if got := tableRows(t, s, "SELECT * FROM "+table); len(got) != 0 {
			t.Errorf("%s = %v, want empty", table, got)
		}
	}
}

// payloadOf turns a stored event back into its typed payload.
func payloadOf(t *testing.T, e event.Event) event.Payload {
	t.Helper()
	for _, p := range event.Types {
		if p.EventType().Name != e.Type {
			continue
		}
		v := reflect.New(reflect.TypeOf(p))
		if err := json.Unmarshal(e.Data, v.Interface()); err != nil {
			t.Fatal(err)
		}
		return v.Elem().Interface().(event.Payload)
	}
	t.Fatalf("unknown event type %q", e.Type)
	return nil
}

func TestViewsRebuiltByReplayEqualTheLiveOnes(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, first := newChat(t, s, "one")
	appendTo(t, s, "run:"+first, event.RunStarted{ChatID: chatID}, answer(chatID, "a", false),
		event.RunFinished{ChatID: chatID, State: "done"})
	appendTo(t, s, "chat:"+chatID, event.ChatTitled{Title: "T", Source: "user"}, event.ChatModel{Model: "m2"})
	second := NewID()
	queueRun(t, s, chatID, second, "two")
	appendTo(t, s, "run:"+second, event.RunStarted{ChatID: chatID}, event.RunPaused{ChatID: chatID, Reason: "interrupted"},
		event.RunResumed{ChatID: chatID}, event.CompactionCompleted{ChatID: chatID, Summary: "sum", FirstKeptSeq: 3},
		answer(chatID, "half", true),
		event.RunFinished{ChatID: chatID, State: "failed", Error: &event.RunError{Code: "backend_failed", Message: "x"}})
	appendTo(t, s, "chat:"+chatID, event.TurnRetracted{RunID: first})
	newChat(t, s, "another chat")

	events, err := s.Log().Read(ctx, 0, event.Filter{}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	fresh, _ := newEventStore(t)
	var at int64
	fresh.now = func() time.Time { return time.UnixMilli(at) }
	for _, e := range events {
		at = e.Time
		got := appendTo(t, fresh, e.Stream, payloadOf(t, e))
		if got[0].Seq != e.Seq {
			t.Fatalf("replayed seq %d, want %d", got[0].Seq, e.Seq)
		}
	}

	queries := []string{"SELECT rowid, chat_id, body FROM messages_fts ORDER BY 1"}
	for _, table := range viewTables {
		queries = append(queries, "SELECT * FROM "+table+" ORDER BY 1")
	}
	for _, q := range queries {
		if live, rebuilt := tableRows(t, s, q), tableRows(t, fresh, q); !slices.Equal(live, rebuilt) {
			t.Errorf("%s differs:\nlive    %v\nrebuilt %v", q, live, rebuilt)
		}
	}
	if got := len(tableRows(t, s, "SELECT rowid FROM messages_fts")); got == 0 {
		t.Error("messages_fts is empty")
	}
}

// search returns the chats SearchChats finds for q, checking its seq is the log's head.
func search(t *testing.T, s *Store, q string) []ChatHit {
	t.Helper()
	hits, seq, err := s.SearchChats(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if seq != head(t, s) {
		t.Errorf("seq = %d, want head %d", seq, head(t, s))
	}
	return hits
}

func hitIDs(hits []ChatHit) []string {
	ids := []string{}
	for _, h := range hits {
		ids = append(ids, h.Chat.ID)
	}
	return ids
}

func TestSearchFindsAWordOfAnAnswerAndMarksItInTheSnippet(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, runID := newChat(t, s, "tell me about lifetimes")
	appendTo(t, s, "run:"+runID, answer(chatID, "The borrow checker tracks every reference.", false))
	newChat(t, s, "something else entirely")

	hits := search(t, s, "borrow")
	if got := hitIDs(hits); !slices.Equal(got, []string{chatID}) {
		t.Fatalf("hits = %v, want [%s]", got, chatID)
	}
	var matched []string
	var text strings.Builder
	for _, p := range hits[0].Snippet {
		if p.Match {
			matched = append(matched, p.Text)
		}
		text.WriteString(p.Text)
	}
	if !slices.Equal(matched, []string{"borrow"}) || !strings.Contains(text.String(), "The borrow checker") {
		t.Errorf("snippet = %+v", hits[0].Snippet)
	}
}

func TestSearchMatchesAPrefixAndAWordWithoutItsDiacritics(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, _ := newChat(t, s, "Ce cărți îmi recomanzi?")
	for _, q := range []string{"carti", "căr", "CAR", "recom"} {
		if got := hitIDs(search(t, s, q)); !slices.Equal(got, []string{chatID}) {
			t.Errorf("%q: hits = %v", q, got)
		}
	}
}

func TestSearchNeedsEveryWordAndAQueryOfOnlyPunctuationFindsNothing(t *testing.T) {
	s, _ := newEventStore(t)
	both, _ := newChat(t, s, "red apples and green pears")
	newChat(t, s, "red cars")

	if got := hitIDs(search(t, s, "red, pears!")); !slices.Equal(got, []string{both}) {
		t.Errorf("two words: %v, want [%s]", got, both)
	}
	for _, q := range []string{"", "  ", `"*-(),.`} {
		if got := search(t, s, q); len(got) != 0 {
			t.Errorf("%q: hits = %v, want none", q, hitIDs(got))
		}
	}
}

func TestSearchByTitleOnlyHasNoSnippetAndARenamedTitleNoLongerMatches(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, _ := newChat(t, s, "hello there")
	appendTo(t, s, "chat:"+chatID, event.ChatTitled{Title: "Trip to Cluj", Source: "auto"})

	hits := search(t, s, "cluj")
	if got := hitIDs(hits); !slices.Equal(got, []string{chatID}) || hits[0].Snippet != nil {
		t.Fatalf("title hit = %+v", hits)
	}
	appendTo(t, s, "chat:"+chatID, event.ChatTitled{Title: "Holiday plans", Source: "user"})
	if got := search(t, s, "cluj"); len(got) != 0 {
		t.Errorf("old title still matches: %v", hitIDs(got))
	}
	if got := hitIDs(search(t, s, "holiday")); !slices.Equal(got, []string{chatID}) {
		t.Errorf("new title: %v", got)
	}
	// An auto title the view refuses (the user's stays) is not findable either.
	appendTo(t, s, "chat:"+chatID, event.ChatTitled{Title: "Ignored words", Source: "auto"})
	if got := search(t, s, "ignored"); len(got) != 0 {
		t.Errorf("refused auto title matches: %v", hitIDs(got))
	}
}

func TestSearchLeavesOutReasoning(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, runID := newChat(t, s, "hi")
	appendTo(t, s, "run:"+runID, event.MessageCompleted{ChatID: chatID, Model: "m1", Parts: []event.MessagePart{
		{Kind: "reasoning", Text: "pondering zebras"}, {Kind: "text", Text: "Hello!"},
	}})
	if got := search(t, s, "zebras"); len(got) != 0 {
		t.Errorf("reasoning matched: %v", hitIDs(got))
	}
	if got := hitIDs(search(t, s, "hello")); !slices.Equal(got, []string{chatID}) {
		t.Errorf("answer text: %v", got)
	}
}

func TestSearchNoLongerFindsARetractedRunsMessagesButFindsAnotherRuns(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, first := newChat(t, s, "first question")
	appendTo(t, s, "run:"+first, answer(chatID, "walrus", false), event.RunFinished{ChatID: chatID, State: "done"})
	second := NewID()
	queueRun(t, s, chatID, second, "second question")
	appendTo(t, s, "run:"+second, answer(chatID, "penguin", false), event.RunFinished{ChatID: chatID, State: "done"})
	appendTo(t, s, "chat:"+chatID, event.TurnRetracted{RunID: second})

	if got := search(t, s, "penguin"); len(got) != 0 {
		t.Errorf("retracted answer matched: %v", hitIDs(got))
	}
	if got := search(t, s, "second"); len(got) != 0 {
		t.Errorf("retracted input matched: %v", hitIDs(got))
	}
	if got := hitIDs(search(t, s, "walrus")); !slices.Equal(got, []string{chatID}) {
		t.Errorf("other run: %v", got)
	}
}

func TestSearchListsNewestFirstAndNeverAChatWithNoMessages(t *testing.T) {
	s, _ := newEventStore(t)
	older, _ := newChat(t, s, "shared word one")
	newer, _ := newChat(t, s, "shared word two")
	empty := NewID()
	appendTo(t, s, "chat:"+empty, event.ChatCreated{Model: "m1", Profile: "chat"},
		event.ChatTitled{Title: "shared title", Source: "user"})

	if got := hitIDs(search(t, s, "shared")); !slices.Equal(got, []string{newer, older}) {
		t.Errorf("hits = %v, want [newer older]", got)
	}
}

func TestSearchFindsNothingOfADeletedChat(t *testing.T) {
	s, _ := newEventStore(t)
	gone, goneRun := newChat(t, s, "common unique")
	appendTo(t, s, "run:"+goneRun, answer(gone, "answer", false))
	kept, _ := newChat(t, s, "common")

	if err := s.DeleteChat(ctx, gone); err != nil {
		t.Fatal(err)
	}
	if got := search(t, s, "unique"); len(got) != 0 {
		t.Errorf("deleted chat matched: %v", hitIDs(got))
	}
	if got := hitIDs(search(t, s, "common")); !slices.Equal(got, []string{kept}) {
		t.Errorf("hits = %v", got)
	}
	if got := tableRows(t, s, "SELECT rowid FROM messages_fts WHERE chat_id = ?", gone); len(got) != 0 {
		t.Errorf("rows left: %v", got)
	}
}

func TestVersion6DatabaseWithChatsMigratesTo7AndFindsThemByTitleAndText(t *testing.T) {
	dir := t.TempDir()
	old, err := open(dir, event.NewBus(16), embeddedMigrations(t, 6), "m")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO chats (id, title, model, profile, created_at, updated_at, last_seq)
			VALUES ('c1', 'Trip to Cluj', 'm1', 'chat', 1, 1, 3)`,
		`INSERT INTO messages (seq, chat_id, run_id, role, parts, created_at)
			VALUES (1, 'c1', 'r1', 'user', '[{"kind":"text","text":"Where to eat?"}]', 1)`,
		`INSERT INTO messages (seq, chat_id, run_id, role, parts, created_at) VALUES (2, 'c1', 'r1', 'assistant',
			'[{"kind":"reasoning","text":"hmm zebras"},{"kind":"text","text":"Try the "},{"kind":"text","text":"bistro."}]', 1)`,
		`INSERT INTO messages (seq, chat_id, run_id, role, parts, retracted, created_at)
			VALUES (3, 'c1', 'r0', 'assistant', '[{"kind":"text","text":"walrus"}]', 1, 1)`,
		`INSERT INTO messages (seq, chat_id, run_id, role, parts, created_at)
			VALUES (4, 'c1', 'r1', 'summary', '[{"kind":"text","text":"penguin"}]', 1)`,
	} {
		if _, err := old.writer().Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()

	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.Version(); v != 8 {
		t.Fatalf("version = %d", v)
	}
	for q, want := range map[string]int{"cluj": 1, "eat": 1, "the bistro": 1, "zebras": 0, "walrus": 0, "penguin": 0} {
		if got := search(t, s, q); len(got) != want {
			t.Errorf("%q: %d hits, want %d", q, len(got), want)
		}
	}
	if got := search(t, s, "cluj"); len(got) == 1 && got[0].Snippet != nil {
		t.Errorf("title hit has snippet %+v", got[0].Snippet)
	}
}

func TestVersion5DatabaseWithOldChatsMigratesAndHasNoChats(t *testing.T) {
	dir := t.TempDir()
	old, err := open(dir, event.NewBus(16), embeddedMigrations(t, 5), "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.writer().Exec(`INSERT INTO chats (id, created_at, updated_at) VALUES ('old', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.Version(); v != 8 {
		t.Fatalf("version = %d", v)
	}
	for _, table := range viewTables {
		if got := tableRows(t, s, "SELECT * FROM "+table); len(got) != 0 {
			t.Errorf("%s = %v, want empty", table, got)
		}
	}
}

func head(t *testing.T, s *Store) int64 {
	t.Helper()
	info, err := s.Log().Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return info.Head
}

func chatIDs(rows []ChatRow) []string {
	ids := []string{}
	for _, c := range rows {
		ids = append(ids, c.ID)
	}
	return ids
}

func TestChatsListsNewestFirstAndLeavesOutChatWithNoMessages(t *testing.T) {
	s, _ := newEventStore(t)
	older, olderRun := newChat(t, s, "older")
	newer, _ := newChat(t, s, "newer")
	appendTo(t, s, "chat:"+NewID(), event.ChatCreated{Model: "m1", Profile: "chat"})

	rows, seq, err := s.Chats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := chatIDs(rows); !slices.Equal(got, []string{newer, older}) {
		t.Errorf("chats = %v, want [newer older]", got)
	}
	if seq != head(t, s) {
		t.Errorf("seq = %d, want head %d", seq, head(t, s))
	}
	if rows[1].Title != "older" || rows[1].ActiveRun != olderRun || rows[1].ActiveState != "queued" {
		t.Errorf("older = %+v", rows[1])
	}

	appendTo(t, s, "run:"+olderRun, event.RunFinished{ChatID: older, State: "done"})
	rows, _, err = s.Chats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := chatIDs(rows); !slices.Equal(got, []string{older, newer}) {
		t.Errorf("after finishing older: %v, want [older newer]", got)
	}
}

func TestChatTranscriptAndRunReturnErrNotFoundForUnknownIDs(t *testing.T) {
	s, _ := newEventStore(t)
	newChat(t, s, "hi")
	if _, _, err := s.Chat(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Chat: %v", err)
	}
	if _, _, _, err := s.Transcript(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Transcript: %v", err)
	}
	if _, _, err := s.Run(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Run: %v", err)
	}
}

func TestTranscriptReturnsMessagesAndRunsOldestFirstWithSeqAtOrAboveNewestMessage(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, first := newChat(t, s, "one")
	appendTo(t, s, "run:"+first, answer(chatID, "a", false), event.RunFinished{ChatID: chatID, State: "done"})
	second := NewID()
	queueRun(t, s, chatID, second, "two")
	appendTo(t, s, "run:"+second, answer(chatID, "b", true))

	msgs, runs, seq, err := s.Transcript(ctx, chatID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for i, m := range msgs {
		if i > 0 && m.Seq <= msgs[i-1].Seq {
			t.Errorf("message %d seq %d not after %d", i, m.Seq, msgs[i-1].Seq)
		}
		got = append(got, m.Role+" "+m.RunID+" "+string(m.Parts))
	}
	want := []string{
		"user " + first + ` [{"kind":"text","text":"one"}]`,
		"assistant " + first + ` [{"kind":"text","text":"a"}]`,
		"user " + second + ` [{"kind":"text","text":"two"}]`,
		"assistant " + second + ` [{"kind":"text","text":"b"}]`,
	}
	if !slices.Equal(got, want) {
		t.Errorf("messages = %v\nwant %v", got, want)
	}
	if !msgs[3].Partial || msgs[3].Failed || msgs[3].Retracted {
		t.Errorf("last message flags = %+v", msgs[3])
	}
	if len(runs) != 2 || runs[0].ID != first || runs[1].ID != second || runs[0].State != "done" || runs[0].FinishedAt == 0 ||
		runs[1].FinishedAt != 0 {
		t.Errorf("runs = %+v", runs)
	}
	if seq < msgs[3].Seq {
		t.Errorf("seq %d below the newest message's %d", seq, msgs[3].Seq)
	}
	if r, rseq, err := s.Run(ctx, second); err != nil || r.ChatID != chatID || r.State != "queued" || rseq < r.LastSeq {
		t.Errorf("Run = %+v, %d, %v", r, rseq, err)
	}
}

func TestOpenRunsReturnsOnlyQueuedAndRunningRuns(t *testing.T) {
	s, _ := newEventStore(t)
	_, queued := newChat(t, s, "queued")
	runningChat, running := newChat(t, s, "running")
	appendTo(t, s, "run:"+running, event.RunStarted{ChatID: runningChat})
	pausedChat, paused := newChat(t, s, "paused")
	appendTo(t, s, "run:"+paused, event.RunStarted{ChatID: pausedChat}, event.RunPaused{ChatID: pausedChat, Reason: "interrupted"})
	doneChat, done := newChat(t, s, "done")
	appendTo(t, s, "run:"+done, event.RunFinished{ChatID: doneChat, State: "done"})

	rows, err := s.OpenRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range rows {
		got = append(got, r.ID)
	}
	if !slices.Equal(got, []string{queued, running}) {
		t.Errorf("open runs = %v, want [queued running]", got)
	}
}

func TestRequestFindsRunByItsRequestIDAndByQueuedInputs(t *testing.T) {
	s, _ := newEventStore(t)
	chatID, runID := NewID(), NewID()
	appendTo(t, s, "chat:"+chatID, event.ChatCreated{Model: "m1", Profile: "chat"})
	first := queueRun(t, s, chatID, runID, "one")
	appendTo(t, s, "run:"+runID, event.InputReceived{ChatID: chatID, Text: "more", RequestID: "req-2"})

	for _, id := range []string{first, "req-2"} {
		ref, ok, err := s.Request(ctx, id)
		if err != nil || !ok || ref != (RequestRef{RunID: runID, ChatID: chatID}) {
			t.Errorf("Request(%s) = %+v, %v, %v", id, ref, ok, err)
		}
	}
	if _, ok, err := s.Request(ctx, "unknown"); ok || err != nil {
		t.Errorf("unknown request: ok %v, err %v", ok, err)
	}
}

func TestDeleteChatRemovesItsAndItsRunsEventsAndRowsKeepsOthersAndPublishes(t *testing.T) {
	s, bus := newEventStore(t)
	gone, goneRun := newChat(t, s, "gone")
	appendTo(t, s, "run:"+goneRun, answer(gone, "a", false), event.RunFinished{ChatID: gone, State: "done"})
	goneSecond := NewID()
	queueRun(t, s, gone, goneSecond, "again")
	kept, keptRun := newChat(t, s, "kept")
	_, live, cancel := bus.Subscribe(event.Filter{Streams: []string{"system"}})
	defer cancel()

	if err := s.DeleteChat(ctx, gone); err != nil {
		t.Fatal(err)
	}

	select {
	case e := <-live:
		if e.Type != "chat.deleted" || e.Stream != "system" || string(e.Data) != `{"chatId":"`+gone+`"}` {
			t.Errorf("published %+v", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no chat.deleted published")
	}
	events, err := s.Log().Read(ctx, 0, event.Filter{}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var streams []string
	for _, e := range events {
		streams = append(streams, e.Stream+" "+e.Type)
	}
	want := []string{
		"chat:" + kept + " chat.created", "run:" + keptRun + " run.queued", "run:" + keptRun + " input.received",
		"system chat.deleted",
	}
	if !slices.Equal(streams, want) {
		t.Errorf("events = %v\nwant %v", streams, want)
	}
	for table, column := range map[string]string{"chats": "id", "runs": "chat_id", "messages": "chat_id", "requests": "chat_id"} {
		if got := tableRows(t, s, "SELECT * FROM "+table+" WHERE "+column+" = ?", gone); len(got) != 0 {
			t.Errorf("%s still has %v", table, got)
		}
	}
	if got := row(t, s, "SELECT count(*) FROM runs WHERE id IN (?, ?)", goneRun, goneSecond); got != "[0]" {
		t.Errorf("gone runs left: %s", got)
	}
	if rows, _, err := s.Chats(ctx); err != nil || !slices.Equal(chatIDs(rows), []string{kept}) {
		t.Errorf("chats = %v, %v", chatIDs(rows), err)
	}
	if _, runs, _, err := s.Transcript(ctx, kept); err != nil || len(runs) != 1 {
		t.Errorf("kept transcript runs = %+v, %v", runs, err)
	}
}

func TestDeleteChatOfUnknownChatIsErrNotFoundAndAppendsNothing(t *testing.T) {
	s, _ := newEventStore(t)
	newChat(t, s, "hi")
	before := head(t, s)
	if err := s.DeleteChat(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if after := head(t, s); after != before {
		t.Errorf("head moved from %d to %d", before, after)
	}
}
