package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

var ctx = context.Background()

// clock returns a store whose time moves forward 1 s per call, so ordering is deterministic.
func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	base := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	n := 0
	s.now = func() time.Time { n++; return base.Add(time.Duration(n) * time.Second) }
	return s
}

// must unwraps a (value, error) pair: Go allows f(g()) only when f takes exactly g's results, so no t parameter here.
// A panic fails the test with the stack, which is fine for setup steps.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func TestNewIDIsUUIDv4AndUnique(t *testing.T) {
	a, b := NewID(), NewID()
	if a == b || len(a) != 36 || a[14] != '4' || !strings.ContainsRune("89ab", rune(a[19])) {
		t.Fatalf("bad ids: %s %s", a, b)
	}
}

func TestCutTitle(t *testing.T) {
	long := "Please explain how the Rust borrow checker decides when a reference is still alive in a loop"
	cases := map[string]string{
		"  hello \n  world ":    "hello world",
		long:                    "Please explain how the Rust borrow checker…",
		strings.Repeat("a", 80): strings.Repeat("a", 50) + "…",
		"":                      "",
	}
	for in, want := range cases {
		if got := CutTitle(in); got != want {
			t.Errorf("CutTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFirstMessageGivesTheTitleAndListHidesEmptyChats(t *testing.T) {
	s := newStore(t)
	empty := must(s.CreateChat(ctx, "m1", false))
	c := must(s.CreateChat(ctx, "m1", true))
	if !c.WebSearch || c.TitleSource != TitleAuto {
		t.Fatalf("chat = %+v", c)
	}
	must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleUser, Content: "What is WAL?"}))
	must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleUser, Content: "A second question"}))

	got := must(s.GetChat(ctx, c.ID))
	if got.Title != "What is WAL?" {
		t.Fatalf("title = %q", got.Title)
	}
	list := must(s.ListChats(ctx))
	if len(list) != 1 || list[0].ID != c.ID {
		t.Fatalf("list = %+v (empty chat %s must be hidden)", list, empty.ID)
	}
}

func TestListIsNewestFirstAndMessagesOldestFirst(t *testing.T) {
	s := newStore(t)
	a := must(s.CreateChat(ctx, "m", false))
	b := must(s.CreateChat(ctx, "m", false))
	must(s.AddMessage(ctx, Message{ChatID: a.ID, Role: RoleUser, Content: "a1"}))
	must(s.AddMessage(ctx, Message{ChatID: b.ID, Role: RoleUser, Content: "b1"}))
	reply := must(s.AddMessage(ctx, Message{ChatID: a.ID, Role: RoleAssistant, Content: "a2"}))

	list := must(s.ListChats(ctx))
	if len(list) != 2 || list[0].ID != a.ID { // a was touched last
		t.Fatalf("order = %v", list)
	}
	msgs := must(s.Messages(ctx, a.ID))
	if len(msgs) != 2 || msgs[0].Content != "a1" || msgs[1].ID != reply.ID {
		t.Fatalf("messages = %+v", msgs)
	}
	if msgs[0].Status != StatusDone || string(msgs[0].Stats) != "{}" {
		t.Fatalf("defaults wrong: %+v", msgs[0])
	}
}

func TestUpdateChatTitleBecomesUsersAndBeatsAutoTitle(t *testing.T) {
	s := newStore(t)
	c := must(s.CreateChat(ctx, "m", false))
	must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleUser, Content: "hi"}))

	title, model, web := " Trip to Cluj ", "m2", true
	got := must(s.UpdateChat(ctx, c.ID, ChatUpdate{Title: &title, Model: &model, WebSearch: &web}))
	if got.Title != "Trip to Cluj" || got.TitleSource != TitleUser || got.Model != "m2" || !got.WebSearch {
		t.Fatalf("chat = %+v", got)
	}
	if err := s.SetAutoTitle(ctx, c.ID, "Generated"); err != nil {
		t.Fatal(err)
	}
	if after := must(s.GetChat(ctx, c.ID)); after.Title != "Trip to Cluj" {
		t.Fatalf("auto title overwrote the user's: %q", after.Title)
	}
}

func TestSetAutoTitleReplacesCutTitle(t *testing.T) {
	s := newStore(t)
	c := must(s.CreateChat(ctx, "m", false))
	must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleUser, Content: "hi"}))
	if err := s.SetAutoTitle(ctx, c.ID, "Greeting"); err != nil {
		t.Fatal(err)
	}
	if got := must(s.GetChat(ctx, c.ID)); got.Title != "Greeting" || got.TitleSource != TitleAuto {
		t.Fatalf("chat = %+v", got)
	}
}

func TestUpdateMessageStoresTheFinishedAnswer(t *testing.T) {
	s := newStore(t)
	c := must(s.CreateChat(ctx, "m", false))
	m := must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleAssistant}))
	err := s.UpdateMessage(ctx, m.ID, MessageUpdate{Content: "partial", Reasoning: "hmm", Status: StatusStopped,
		Stats: []byte(`{"tokens":3}`)})
	if err != nil {
		t.Fatal(err)
	}
	got := must(s.Messages(ctx, c.ID))[0]
	if got.Content != "partial" || got.Status != StatusStopped || string(got.Stats) != `{"tokens":3}` {
		t.Fatalf("message = %+v", got)
	}
	if err := s.UpdateMessage(ctx, "nope", MessageUpdate{Status: StatusDone}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestDeleteChatCascadesToMessages(t *testing.T) {
	s := newStore(t)
	c := must(s.CreateChat(ctx, "m", false))
	must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleUser, Content: "x"}))
	if err := s.DeleteChat(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.reader().QueryRow("SELECT count(*) FROM messages").Scan(&n); err != nil || n != 0 {
		t.Fatalf("messages left: %d %v", n, err)
	}
	if _, err := s.GetChat(ctx, c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if err := s.DeleteChat(ctx, c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err = %v", err)
	}
}

func TestMissingChatIsNotFound(t *testing.T) {
	s := newStore(t)
	if _, err := s.AddMessage(ctx, Message{ChatID: "nope", Role: RoleUser, Content: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("AddMessage err = %v", err)
	}
	title := "x"
	if _, err := s.UpdateChat(ctx, "nope", ChatUpdate{Title: &title}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UpdateChat err = %v", err)
	}
}

func TestDeleteMessage(t *testing.T) {
	s := newStore(t)
	c := must(s.CreateChat(ctx, "m", false))
	m := must(s.AddMessage(ctx, Message{ChatID: c.ID, Role: RoleUser, Content: "x"}))
	if err := s.DeleteMessage(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if got := must(s.Messages(ctx, c.ID)); len(got) != 0 {
		t.Fatalf("messages = %+v", got)
	}
}
