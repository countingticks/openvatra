package config

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/store"
)

// testSection is a small section type: N must not be negative.
type testSection struct {
	N int     `json:"n"`
	S *string `json:"s"`
}

func (v testSection) Validate() error {
	if v.N < 0 {
		return errors.New("n must not be negative")
	}
	return nil
}

const testName = "test"

var testDefaults = testSection{N: 7}

func testEffective(v testSection) any { return map[string]int{"double": v.N * 2} }

// openDB opens a real database in dir and closes it when the test ends.
func openDB(t *testing.T, dir string) *store.Store {
	t.Helper()
	db, err := store.Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// newTestStore registers the test section on a config store over db (nil for none).
func newTestStore(t *testing.T, db DB, log *bytes.Buffer) *Store {
	t.Helper()
	if log == nil {
		log = &bytes.Buffer{}
	}
	s := New(db, slog.New(slog.NewTextHandler(log, nil)))
	Register(s, testName, testDefaults, testEffective)
	return s
}

func mustSection(t *testing.T, s *Store) SectionEntry {
	t.Helper()
	e, err := s.Section(testName)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestUnwrittenSectionReadsDefaults(t *testing.T) {
	s := newTestStore(t, openDB(t, t.TempDir()), nil)
	e := mustSection(t, s)
	if e.Rev != 0 || string(e.Value) != `{"n":7,"s":null}` || string(e.Effective) != `{"double":14}` {
		t.Fatalf("entry = rev %d, value %s, effective %s", e.Rev, e.Value, e.Effective)
	}
	if got := Get[testSection](s, testName); got.N != 7 {
		t.Fatalf("Get = %+v", got)
	}
	if all := s.All(); len(all) != 1 || all[testName].Rev != 0 {
		t.Fatalf("All = %v", all)
	}
}

func TestPutSavesAndReadsBack(t *testing.T) {
	dir := t.TempDir()
	s := newTestStore(t, openDB(t, dir), nil)
	e, err := s.Put(testName, 0, json.RawMessage(`{"n":3,"s":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if e.Rev != 1 || string(e.Value) != `{"n":3,"s":"x"}` || string(e.Effective) != `{"double":6}` {
		t.Fatalf("Put = rev %d, value %s, effective %s", e.Rev, e.Value, e.Effective)
	}
	if got := mustSection(t, s); got.Rev != 1 || string(got.Value) != `{"n":3,"s":"x"}` {
		t.Fatalf("Section = rev %d, value %s", got.Rev, got.Value)
	}
	if got := Get[testSection](s, testName); got.N != 3 || got.S == nil || *got.S != "x" {
		t.Fatalf("Get = %+v", got)
	}

	reopened := newTestStore(t, openDB(t, dir), nil)
	if got := Get[testSection](reopened, testName); got.N != 3 || mustSection(t, reopened).Rev != 1 {
		t.Fatalf("a new store on the same database reads %+v", got)
	}
}

func TestPutMissingFieldsAreZeroAndStoredInFull(t *testing.T) {
	s := newTestStore(t, openDB(t, t.TempDir()), nil)
	e, err := s.Put(testName, 0, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(e.Value) != `{"n":0,"s":null}` {
		t.Fatalf("value = %s", e.Value)
	}
}

// assertUnchanged checks that the test section is still at rev 0 with the defaults, and nobody was notified.
func assertUnchanged(t *testing.T, s *Store, db *store.Store, notified int) {
	t.Helper()
	if e := mustSection(t, s); e.Rev != 0 || string(e.Value) != `{"n":7,"s":null}` {
		t.Fatalf("cache changed: rev %d, value %s", e.Rev, e.Value)
	}
	if rev, data, err := db.ConfigGet(context.Background(), testName); err != nil || rev != 0 || data != nil {
		t.Fatalf("database changed: rev %d, %s, %v", rev, data, err)
	}
	if notified != 0 {
		t.Fatalf("notified %d times", notified)
	}
}

func TestPutWithAStaleRevConflicts(t *testing.T) {
	db := openDB(t, t.TempDir())
	s := newTestStore(t, db, nil)
	if _, err := s.Put(testName, 0, json.RawMessage(`{"n":1}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(testName, 0, json.RawMessage(`{"n":2}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	if got := Get[testSection](s, testName); got.N != 1 || mustSection(t, s).Rev != 1 {
		t.Fatalf("a conflicting Put changed the cache: %+v", got)
	}
	if rev, data, _ := db.ConfigGet(context.Background(), testName); rev != 1 || string(data) != `{"n":1,"s":null}` {
		t.Fatalf("a conflicting Put changed the database: rev %d, %s", rev, data)
	}
}

func TestPutRejectsInvalidValues(t *testing.T) {
	cases := []struct{ name, value, message string }{
		{"unknown field", `{"n":1,"x":2}`, `unknown field "x"`},
		{"wrong type", `{"n":"1"}`, "n has the wrong type"},
		{"invalid JSON", `{"n":`, "the value is not valid JSON"},
		{"null", `null`, "the value must be an object"},
		{"failing Validate", `{"n":-1}`, "n must not be negative"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := openDB(t, t.TempDir())
			s := newTestStore(t, db, nil)
			notified := 0
			s.Subscribe(func(string, int) { notified++ })
			_, err := s.Put(testName, 0, json.RawMessage(tc.value))
			var invalid *InvalidError
			if !errors.As(err, &invalid) || invalid.Message != tc.message {
				t.Fatalf("err = %v, want InvalidError %q", err, tc.message)
			}
			assertUnchanged(t, s, db, notified)
		})
	}
}

func TestUnknownSection(t *testing.T) {
	s := newTestStore(t, openDB(t, t.TempDir()), nil)
	if _, err := s.Section("nope"); !errors.Is(err, ErrUnknownSection) {
		t.Fatalf("Section: err = %v", err)
	}
	if _, err := s.Put("nope", 0, json.RawMessage(`{}`)); !errors.Is(err, ErrUnknownSection) {
		t.Fatalf("Put: err = %v", err)
	}
}

func TestWithoutADatabase(t *testing.T) {
	s := newTestStore(t, nil, nil)
	if e := mustSection(t, s); e.Rev != 0 || Get[testSection](s, testName).N != 7 {
		t.Fatalf("entry = %+v", e)
	}
	if _, err := s.Put(testName, 0, json.RawMessage(`{"n":1}`)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestReadOnlyDatabase(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ConfigPut(context.Background(), testName, 0, []byte(`{"n":5,"s":null}`)); err != nil {
		t.Fatal(err)
	}
	db.Close()
	// A newer OpenVatra wrote it: its schema version is past what this one knows.
	raw, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "openvatra.db")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("PRAGMA user_version = 9999"); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	ro := openDB(t, dir)
	if ro.ReadOnly() == nil {
		t.Fatal("the database did not open read-only")
	}
	s := newTestStore(t, ro, nil)
	if got := Get[testSection](s, testName); got.N != 5 || mustSection(t, s).Rev != 1 {
		t.Fatalf("read-only database reads %+v", got)
	}
	if _, err := s.Put(testName, 1, json.RawMessage(`{"n":6}`)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestStoredValueThatNoLongerValidates(t *testing.T) {
	db := openDB(t, t.TempDir())
	if _, err := db.ConfigPut(context.Background(), testName, 0, []byte(`{"n":-3,"s":null}`)); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	s := newTestStore(t, db, &log)
	if e := mustSection(t, s); e.Rev != 1 || string(e.Value) != `{"n":7,"s":null}` {
		t.Fatalf("entry = rev %d, value %s, want the defaults at rev 1", e.Rev, e.Value)
	}
	if n := strings.Count(log.String(), "level=ERROR"); n != 1 || !strings.Contains(log.String(), testName) {
		t.Fatalf("log = %q, want one error naming the section", log.String())
	}
	if e, err := s.Put(testName, 1, json.RawMessage(`{"n":2}`)); err != nil || e.Rev != 2 {
		t.Fatalf("Put = %+v, %v", e, err)
	}
}

func TestSubscribe(t *testing.T) {
	s := newTestStore(t, openDB(t, t.TempDir()), nil)
	type call struct {
		section string
		rev     int
	}
	var calls []call
	cancel := s.Subscribe(func(section string, rev int) {
		calls = append(calls, call{section, rev})
		if Get[testSection](s, testName).N != rev*10 { // the cache is already updated
			t.Errorf("subscriber saw a stale value at rev %d", rev)
		}
	})

	if _, err := s.Put(testName, 0, json.RawMessage(`{"n":10}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(testName, 1, json.RawMessage(`{"n":-1}`)); err == nil {
		t.Fatal("an invalid value was accepted")
	}
	if _, err := s.Put(testName, 1, json.RawMessage(`{"n":20}`)); err != nil {
		t.Fatal(err)
	}
	cancel()
	cancel()
	if _, err := s.Put(testName, 2, json.RawMessage(`{"n":30}`)); err != nil {
		t.Fatal(err)
	}

	want := []call{{testName, 1}, {testName, 2}}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

type otherSection struct{}

func (otherSection) Validate() error { return nil }

func TestWiringBugsPanic(t *testing.T) {
	s := newTestStore(t, nil, nil)
	mustPanic := func(name string, f func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Errorf("%s did not panic", name)
			}
		}()
		f()
	}
	mustPanic("a duplicate Register", func() { Register[testSection, struct{}](s, testName, testDefaults, nil) })
	mustPanic("Get with the wrong type", func() { Get[otherSection](s, testName) })
	mustPanic("Get of an unknown section", func() { Get[testSection](s, "nope") })
}

type doubled struct {
	Double int `json:"double"`
}

func TestSectionsListsRegistrationOrderAndTypes(t *testing.T) {
	s := New(nil, nil)
	Register(s, "zeta", testDefaults, func(v testSection) doubled { return doubled{v.N * 2} })
	Register[otherSection, struct{}](s, "alpha", otherSection{}, nil)

	got := s.Sections()
	want := []SectionType{
		{Name: "zeta", Value: reflect.TypeFor[testSection](), Effective: reflect.TypeFor[doubled]()},
		{Name: "alpha", Value: reflect.TypeFor[otherSection]()},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Sections() = %v, want %v", got, want)
	}
}

func TestSectionsListsTheModelsSectionsShellOnlyFields(t *testing.T) {
	s := New(nil, nil)
	Register[Models, struct{}](s, ModelsSection, DefaultModels(), nil)
	Register[testSection, struct{}](s, testName, testDefaults, nil)
	got := s.Sections()
	if want := []string{"llamaServerPath", "modelsDir"}; !reflect.DeepEqual(got[0].ShellOnly, want) {
		t.Fatalf("models ShellOnly = %v, want %v", got[0].ShellOnly, want)
	}
	if got[1].ShellOnly != nil {
		t.Fatalf("%s ShellOnly = %v, want nil", testName, got[1].ShellOnly)
	}
}

func TestNilEffectiveHasNoType(t *testing.T) {
	s := New(nil, nil)
	Register[testSection, struct{}](s, testName, testDefaults, nil)
	if eff := s.Sections()[0].Effective; eff != nil {
		t.Fatalf("Effective = %v, want nil", eff)
	}
	e := mustSection(t, s)
	if e.Effective != nil {
		t.Fatalf("entry effective = %s, want none", e.Effective)
	}
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "effective") {
		t.Fatalf("entry JSON %s has an effective field", raw)
	}
}
