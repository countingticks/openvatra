package store

import (
	"database/sql"
	"errors"
	"regexp"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

type fakeProjector func(tx *sql.Tx, e event.Event) error

func (f fakeProjector) Apply(tx *sql.Tx, e event.Event) error { return f(tx, e) }

type notDurable struct{}

func (notDurable) EventType() event.Type {
	return event.Type{Name: "test.ephemeral", V: 1, Class: event.Ephemeral}
}

func changed(rev int) event.ConfigChanged { return event.ConfigChanged{Section: "models", Rev: rev} }

// embeddedMigrations is the embedded migration folder cut to the first n steps (all when n < 0) plus extra steps,
// named for open(dir, bus, fsys, "m").
func embeddedMigrations(t *testing.T, n int, extra ...string) fstest.MapFS {
	t.Helper()
	steps, err := load(embedded, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	if n >= 0 {
		steps = steps[:n]
	}
	return migrations(append(steps, extra...)...)
}

func panics(f func()) (did bool) {
	defer func() { did = recover() != nil }()
	f()
	return false
}

func TestEventsMigrationAppliesOnVersion3AndKeepsConfig(t *testing.T) {
	dir := t.TempDir()
	old, err := open(dir, event.NewBus(16), embeddedMigrations(t, 3), "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.writer().Exec(`INSERT INTO config (section, rev, value) VALUES ('models', 2, '{"a":1}')`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.Version(); v != 4 {
		t.Fatalf("version = %d", v)
	}
	if rev, v, err := s.ConfigGet(ctx, "models"); err != nil || rev != 2 || string(v) != `{"a":1}` {
		t.Fatalf("config lost: %d, %q, %v", rev, v, err)
	}
	if info, err := s.Log().Info(ctx); err != nil || info.Head != 0 || info.ID == "" {
		t.Fatalf("info = %+v, %v", info, err)
	}
}

func TestAppendAssignsIncreasingSeqsAndFillsTheEnvelope(t *testing.T) {
	s, _ := newEventStore(t)
	log := s.Log()
	first, err := log.Append(ctx, "system", changed(1))
	if err != nil {
		t.Fatal(err)
	}
	second, err := log.Append(ctx, "system", changed(2))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || len(second) != 1 || second[0].Seq <= first[0].Seq || first[0].Seq < 1 {
		t.Fatalf("seqs: %+v then %+v", first, second)
	}
	base := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	e := second[0]
	if e.Time != base.Add(2*time.Second).UnixMilli() || e.Stream != "system" || e.Type != "config.changed" ||
		e.V != 1 || string(e.Data) != `{"section":"models","rev":2}` {
		t.Fatalf("event = %+v (data %s)", e, e.Data)
	}
}

func TestSubscriberGetsEventsOnlyAfterAppendReturns(t *testing.T) {
	s, bus := newEventStore(t)
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	applied := 0
	s.AddProjector(fakeProjector(func(*sql.Tx, event.Event) error {
		applied++
		if len(ch) != 0 {
			t.Error("event published before commit")
		}
		return nil
	}))
	events, err := s.Log().Append(ctx, "system", changed(1), changed(2))
	if err != nil {
		t.Fatal(err)
	}
	if applied != 2 {
		t.Fatalf("projector ran %d times", applied)
	}
	for _, want := range events {
		if got := <-ch; got.Seq != want.Seq {
			t.Fatalf("got seq %d, want %d", got.Seq, want.Seq)
		}
	}
}

func TestFailingProjectorRollsTheAppendBack(t *testing.T) {
	s, bus := newEventStore(t)
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	boom := errors.New("boom")
	s.AddProjector(fakeProjector(func(*sql.Tx, event.Event) error { return boom }))
	if _, err := s.Log().Append(ctx, "system", changed(1)); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if got, err := s.Log().Read(ctx, 0, event.Filter{}, 10); err != nil || len(got) != 0 {
		t.Fatalf("read = %+v, %v", got, err)
	}
	if len(ch) != 0 {
		t.Fatal("event published")
	}
}

func TestReadFiltersAndPages(t *testing.T) {
	s, _ := newEventStore(t)
	log := s.Log()
	for _, stream := range []string{"system", "chat:a", "chat:b", "run:x", "system"} {
		if _, err := log.Append(ctx, stream, changed(1)); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		name   string
		after  int64
		filter []string
		limit  int
		want   []int64
	}{
		{"everything", 0, nil, 10, []int64{1, 2, 3, 4, 5}},
		{"after", 3, nil, 10, []int64{4, 5}},
		{"exact", 0, []string{"system", "chat:b"}, 10, []int64{1, 3, 5}},
		{"kind", 0, []string{"chat:*"}, 10, []int64{2, 3}},
		{"kind and exact", 1, []string{"chat:*", "run:x"}, 10, []int64{2, 3, 4}},
		{"limit", 1, nil, 2, []int64{2, 3}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := log.Read(ctx, tt.after, event.Filter{Streams: tt.filter}, tt.limit)
			if err != nil {
				t.Fatal(err)
			}
			seqs := []int64{}
			for _, e := range got {
				seqs = append(seqs, e.Seq)
			}
			if len(seqs) != len(tt.want) {
				t.Fatalf("seqs = %v, want %v", seqs, tt.want)
			}
			for i := range seqs {
				if seqs[i] != tt.want[i] {
					t.Fatalf("seqs = %v, want %v", seqs, tt.want)
				}
			}
		})
	}
	got, _ := log.Read(ctx, 1, event.Filter{Streams: []string{"chat:a"}}, 1)
	if e := got[0]; e.Stream != "chat:a" || e.Type != "config.changed" || e.V != 1 || e.Class() != event.Durable ||
		string(e.Data) != `{"section":"models","rev":1}` {
		t.Fatalf("read back %+v", e)
	}
}

func TestWiringBugsPanic(t *testing.T) {
	s, _ := newEventStore(t)
	log := s.Log()
	for name, f := range map[string]func(){
		"limit 0":     func() { log.Read(ctx, 0, event.Filter{}, 0) },
		"limit 1001":  func() { log.Read(ctx, 0, event.Filter{}, 1001) },
		"not durable": func() { log.Append(ctx, "system", notDurable{}) },
	} {
		if !panics(f) {
			t.Errorf("%s did not panic", name)
		}
	}
}

func TestDeletedSeqIsNeverReusedAndHeadNeverDrops(t *testing.T) {
	s, _ := newEventStore(t)
	log := s.Log()
	for rev := 1; rev <= 3; rev++ {
		must(log.Append(ctx, "system", changed(rev)))
	}
	if _, err := s.writer().Exec("DELETE FROM events WHERE seq = 3"); err != nil {
		t.Fatal(err)
	}
	if info := must(log.Info(ctx)); info.Head != 3 {
		t.Fatalf("head after delete = %d", info.Head)
	}
	if got := must(log.Append(ctx, "system", changed(4))); got[0].Seq != 4 {
		t.Fatalf("seq = %d", got[0].Seq)
	}
	if info := must(log.Info(ctx)); info.Head != 4 {
		t.Fatalf("head = %d", info.Head)
	}
}

func TestLogIDIsRandomHexAndSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	id := must(s.Log().Info(ctx)).ID
	s.Close()
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	s, err = Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if again := must(s.Log().Info(ctx)).ID; again != id {
		t.Fatalf("id changed: %q then %q", id, again)
	}
}

func TestReadOnlyStoreReadsButDoesNotWrite(t *testing.T) {
	dir := t.TempDir()
	newer, err := open(dir, event.NewBus(16), embeddedMigrations(t, -1, "CREATE TABLE z(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	must(newer.Log().Append(ctx, "system", changed(1)))
	newer.Close()

	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.ReadOnly() == nil {
		t.Fatal("expected read-only")
	}
	if _, err := s.Log().Append(ctx, "system", changed(2)); !errors.Is(err, event.ErrUnavailable) {
		t.Fatalf("append err = %v", err)
	}
	if got, err := s.Log().Read(ctx, 0, event.Filter{}, 10); err != nil || len(got) != 1 {
		t.Fatalf("read = %+v, %v", got, err)
	}
	if info, err := s.Log().Info(ctx); err != nil || info.Head != 1 || info.ID == "" {
		t.Fatalf("info = %+v, %v", info, err)
	}
	if n, err := s.TrimSystem(ctx, time.Now()); n != 0 || !errors.Is(err, ErrReadOnly) {
		t.Fatalf("trim = %d, %v", n, err)
	}
}

func TestAppendOfNothingUsesNoSeq(t *testing.T) {
	s, _ := newEventStore(t)
	log := s.Log()
	got, err := log.Append(ctx, "system")
	if got != nil || err != nil {
		t.Fatalf("got %+v, %v", got, err)
	}
	if info := must(log.Info(ctx)); info.Head != 0 {
		t.Fatalf("head = %d", info.Head)
	}
	if e := must(log.Append(ctx, "system", changed(1))); e[0].Seq != 1 {
		t.Fatalf("seq = %d", e[0].Seq)
	}
}

func TestConcurrentAppendsArriveInSeqOrder(t *testing.T) {
	s, bus := newEventStore(t)
	_, ch, cancel := bus.Subscribe(event.Filter{})
	defer cancel()
	const n = 20
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			if _, err := s.Log().Append(ctx, "system", changed(i)); err != nil {
				t.Error(err)
			}
		})
	}
	deadline := time.After(10 * time.Second)
	var last int64
	for range n {
		select {
		case e, ok := <-ch:
			if !ok {
				t.Fatal("subscriber fell behind")
			}
			if e.Seq <= last {
				t.Fatalf("seq %d after %d", e.Seq, last)
			}
			last = e.Seq
		case <-deadline:
			t.Fatal("timed out waiting for events")
		}
	}
	wg.Wait()
}

func TestTrimSystemDeletesOnlyOldSystemEvents(t *testing.T) {
	s, _ := newEventStore(t)
	log := s.Log()
	base := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	at := base
	s.now = func() time.Time { return at }
	must(log.Append(ctx, "system", changed(1))) // seq 1: old, goes
	must(log.Append(ctx, "chat:a", changed(1))) // seq 2: old, but not system
	at = base.Add(40 * 24 * time.Hour)
	must(log.Append(ctx, "system", changed(2))) // seq 3: new

	if n, err := s.TrimSystem(ctx, base.Add(10*24*time.Hour)); n != 1 || err != nil {
		t.Fatalf("trim = %d, %v", n, err)
	}
	got := must(log.Read(ctx, 0, event.Filter{}, 10))
	if len(got) != 2 || got[0].Seq != 2 || got[1].Seq != 3 {
		t.Fatalf("left %+v", got)
	}
	if info := must(log.Info(ctx)); info.Head != 3 {
		t.Fatalf("head = %d", info.Head)
	}
}
