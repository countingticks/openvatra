package store

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"testing"

	"github.com/countingticks/openvatra/core/internal/event"
)

func openConfigStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

func TestConfigAbsentSectionReadsAsRevZero(t *testing.T) {
	s, _ := openConfigStore(t)
	rev, v, err := s.ConfigGet(context.Background(), "x")
	if err != nil || rev != 0 || v != nil {
		t.Fatalf("got %d, %q, %v", rev, v, err)
	}
}

func TestConfigPutAdvancesTheRevision(t *testing.T) {
	s, _ := openConfigStore(t)
	ctx := context.Background()
	if rev, err := s.ConfigPut(ctx, "x", 0, []byte(`{"a":1}`)); err != nil || rev != 1 {
		t.Fatalf("first put: %d, %v", rev, err)
	}
	if rev, err := s.ConfigPut(ctx, "x", 1, []byte(`{"a":2}`)); err != nil || rev != 2 {
		t.Fatalf("second put: %d, %v", rev, err)
	}
	rev, v, err := s.ConfigGet(ctx, "x")
	if err != nil || rev != 2 || string(v) != `{"a":2}` {
		t.Fatalf("got %d, %q, %v", rev, v, err)
	}
}

func TestConfigStaleRevisionConflicts(t *testing.T) {
	s, _ := openConfigStore(t)
	ctx := context.Background()
	s.ConfigPut(ctx, "x", 0, []byte(`1`))
	s.ConfigPut(ctx, "x", 1, []byte(`2`))
	if _, err := s.ConfigPut(ctx, "x", 1, []byte(`3`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v", err)
	}
	if rev, v, _ := s.ConfigGet(ctx, "x"); rev != 2 || string(v) != `2` {
		t.Fatalf("changed: %d, %q", rev, v)
	}
}

func TestConfigPutWithRevOnAbsentSectionConflicts(t *testing.T) {
	s, _ := openConfigStore(t)
	if _, err := s.ConfigPut(context.Background(), "x", 1, []byte(`1`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigPutOnReadOnlyStoreIsRefused(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)", "CREATE TABLE b(y)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.ConfigPut(context.Background(), "x", 0, []byte(`1`)); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigMigrationAppliesOnAnOldDatabase(t *testing.T) {
	read := func(name string) string {
		b, err := fs.ReadFile(embedded, "migrations/"+name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	dir := t.TempDir()
	old, err := open(dir, event.NewBus(16), migrations(read("0001_baseline.sql"), read("0002_chats.sql")), "m")
	if err != nil {
		t.Fatal(err)
	}
	chat, err := old.CreateChat(context.Background(), "m", false)
	if err != nil {
		t.Fatal(err)
	}
	old.Close()

	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.Version(); v != 5 {
		t.Fatalf("version = %d", v)
	}
	if _, err := s.GetChat(context.Background(), chat.ID); err != nil {
		t.Fatal("chat lost:", err)
	}
	if _, _, err := s.ConfigGet(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
}

func TestConfigValueSurvivesReopen(t *testing.T) {
	s, dir := openConfigStore(t)
	if _, err := s.ConfigPut(context.Background(), "x", 0, []byte(`{"k":"v"}`)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s2, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if rev, v, _ := s2.ConfigGet(context.Background(), "x"); rev != 1 || string(v) != `{"k":"v"}` {
		t.Fatalf("got %d, %q", rev, v)
	}
}

func TestConfigPutWritesConfigChangedInTheSameCommit(t *testing.T) {
	s, bus := newEventStore(t)
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	must(s.ConfigPut(ctx, "models", 0, []byte(`1`)))
	rev := must(s.ConfigPut(ctx, "models", 1, []byte(`2`)))

	got := must(s.Log().Read(ctx, 1, event.Filter{Streams: []string{"system"}}, 10))
	if len(got) != 1 || got[0].Type != "config.changed" || string(got[0].Data) != `{"section":"models","rev":2}` ||
		rev != 2 {
		t.Fatalf("events = %+v", got)
	}
	for _, wantRev := range []string{`{"section":"models","rev":1}`, `{"section":"models","rev":2}`} {
		if e := <-ch; string(e.Data) != wantRev || e.Stream != "system" {
			t.Fatalf("published %+v (data %s)", e, e.Data)
		}
	}
}

func TestConflictingConfigPutAddsNoEvent(t *testing.T) {
	s, bus := newEventStore(t)
	must(s.ConfigPut(ctx, "models", 0, []byte(`1`)))
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	if _, err := s.ConfigPut(ctx, "models", 0, []byte(`2`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v", err)
	}
	if got := must(s.Log().Read(ctx, 0, event.Filter{}, 10)); len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	if len(ch) != 0 {
		t.Fatal("event published")
	}
}

func TestProjectorErrorRollsTheConfigPutBack(t *testing.T) {
	s, _ := newEventStore(t)
	must(s.ConfigPut(ctx, "models", 0, []byte(`1`)))
	boom := errors.New("boom")
	s.AddProjector(fakeProjector(func(*sql.Tx, event.Event) error { return boom }))
	if _, err := s.ConfigPut(ctx, "models", 1, []byte(`2`)); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if rev, v, _ := s.ConfigGet(ctx, "models"); rev != 1 || string(v) != `1` {
		t.Fatalf("config = %d, %q", rev, v)
	}
}

func readOnlyConfigStore(t *testing.T, seed func(*Store)) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations(configTable, "CREATE TABLE b(y)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	seed(s)
	s.Close()
	s, err = open(dir, event.NewBus(16), migrations(configTable), "m")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

const configTable = "CREATE TABLE config (section TEXT PRIMARY KEY, rev INTEGER NOT NULL, value TEXT NOT NULL)"

func moveTargets() map[string][]byte {
	return map[string][]byte{"provider.b": []byte(`{"b":2}`), "engine.a": []byte(`{"a":1}`)}
}

func TestConfigMoveWritesTheNewSectionsAndRemovesTheOld(t *testing.T) {
	s, _ := newEventStore(t)
	must(s.ConfigPut(ctx, "old", 0, []byte(`{"x":1}`)))
	if moved, err := s.ConfigMove(ctx, "old", moveTargets()); err != nil || !moved {
		t.Fatalf("moved = %v, %v", moved, err)
	}
	for name, want := range moveTargets() {
		if rev, v, _ := s.ConfigGet(ctx, name); rev != 1 || string(v) != string(want) {
			t.Fatalf("%s = %d, %q", name, rev, v)
		}
	}
	if rev, _, _ := s.ConfigGet(ctx, "old"); rev != 0 {
		t.Fatalf("old rev = %d", rev)
	}
}

func TestConfigMoveAppendsConfigChangedPerSectionInNameOrder(t *testing.T) {
	s, bus := newEventStore(t)
	must(s.ConfigPut(ctx, "old", 0, []byte(`1`)))
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	must(s.ConfigMove(ctx, "old", moveTargets()))

	want := []string{`{"section":"engine.a","rev":1}`, `{"section":"provider.b","rev":1}`}
	got := must(s.Log().Read(ctx, 1, event.Filter{Streams: []string{"system"}}, 10))
	if len(got) != 2 || got[0].Type != "config.changed" || got[1].Type != "config.changed" {
		t.Fatalf("events = %+v", got)
	}
	for i, w := range want {
		if string(got[i].Data) != w {
			t.Fatalf("event %d = %s", i, got[i].Data)
		}
		if e := <-ch; string(e.Data) != w || e.Stream != "system" {
			t.Fatalf("published %+v (data %s)", e, e.Data)
		}
	}
}

func TestConfigMoveWithoutTheOldSectionWritesNothing(t *testing.T) {
	s, _ := newEventStore(t)
	if moved, err := s.ConfigMove(ctx, "old", moveTargets()); err != nil || moved {
		t.Fatalf("moved = %v, %v", moved, err)
	}
	for name := range moveTargets() {
		if rev, _, _ := s.ConfigGet(ctx, name); rev != 0 {
			t.Fatalf("%s written", name)
		}
	}
	if got := must(s.Log().Read(ctx, 0, event.Filter{}, 10)); len(got) != 0 {
		t.Fatalf("events = %+v", got)
	}
}

func TestConfigMoveKeepsAnExistingNewSection(t *testing.T) {
	s, bus := newEventStore(t)
	must(s.ConfigPut(ctx, "old", 0, []byte(`1`)))
	must(s.ConfigPut(ctx, "engine.a", 0, []byte(`"kept"`)))
	must(s.ConfigPut(ctx, "engine.a", 1, []byte(`"kept2"`)))
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	if moved, err := s.ConfigMove(ctx, "old", moveTargets()); err != nil || moved {
		t.Fatalf("moved = %v, %v", moved, err)
	}
	if rev, v, _ := s.ConfigGet(ctx, "engine.a"); rev != 2 || string(v) != `"kept2"` {
		t.Fatalf("engine.a = %d, %q", rev, v)
	}
	if rev, _, _ := s.ConfigGet(ctx, "provider.b"); rev != 0 {
		t.Fatal("provider.b written")
	}
	if rev, _, _ := s.ConfigGet(ctx, "old"); rev != 0 {
		t.Fatal("old kept")
	}
	if len(ch) != 0 {
		t.Fatal("event published")
	}
}

func TestConfigMoveToNothingDeletesTheOldSection(t *testing.T) {
	s, _ := newEventStore(t)
	must(s.ConfigPut(ctx, "old", 0, []byte(`1`)))
	if moved, err := s.ConfigMove(ctx, "old", nil); err != nil || moved {
		t.Fatalf("moved = %v, %v", moved, err)
	}
	if rev, _, _ := s.ConfigGet(ctx, "old"); rev != 0 {
		t.Fatal("old kept")
	}
	if got := must(s.Log().Read(ctx, 0, event.Filter{}, 10)); len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
}

func TestConfigMoveOnReadOnlyStoreIsRefused(t *testing.T) {
	s := readOnlyConfigStore(t, func(s *Store) {
		if _, err := s.writer().Exec("INSERT INTO config (section, rev, value) VALUES ('old', 1, '1')"); err != nil {
			t.Fatal(err)
		}
	})
	if moved, err := s.ConfigMove(ctx, "old", moveTargets()); !errors.Is(err, ErrReadOnly) || moved {
		t.Fatalf("moved = %v, %v", moved, err)
	}
	if rev, v, _ := s.ConfigGet(ctx, "old"); rev != 1 || string(v) != `1` {
		t.Fatalf("old = %d, %q", rev, v)
	}
}

func TestProjectorErrorRollsTheConfigMoveBack(t *testing.T) {
	s, _ := newEventStore(t)
	must(s.ConfigPut(ctx, "old", 0, []byte(`1`)))
	boom := errors.New("boom")
	s.AddProjector(fakeProjector(func(*sql.Tx, event.Event) error { return boom }))
	if _, err := s.ConfigMove(ctx, "old", moveTargets()); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if rev, v, _ := s.ConfigGet(ctx, "old"); rev != 1 || string(v) != `1` {
		t.Fatalf("old = %d, %q", rev, v)
	}
	for name := range moveTargets() {
		if rev, _, _ := s.ConfigGet(ctx, name); rev != 0 {
			t.Fatalf("%s written", name)
		}
	}
}
