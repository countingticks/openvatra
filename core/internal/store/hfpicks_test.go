package store

import (
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

func pickFixture(id string, created time.Time, files ...string) HFPick {
	p := HFPick{ID: id, Repo: "o/r", Revision: "0123456789abcdef0123456789abcdef01234567", Quant: "Q4_K_M",
		Created: created}
	for i, name := range files {
		p.Files = append(p.Files, HFPickFile{Name: name, Path: "sub/" + name, SizeBytes: int64(100 + i),
			SHA256: "ab"})
	}
	return p
}

func openPicksStore(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func samePicks(t *testing.T, got []HFPick, want ...HFPick) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("picks = %+v, want %+v", got, want)
	}
}

func TestHFPicksRoundTripKeepsFilesInOrder(t *testing.T) {
	s := openPicksStore(t, t.TempDir())
	defer s.Close()
	older := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "b-00001-of-00002.gguf", "b-00002-of-00002.gguf", "mmproj-F16.gguf")
	newer := pickFixture("hf:o/r:Q8_0", time.UnixMilli(2000), "c.gguf")
	newer.Quant = "Q8_0"
	must(0, s.SaveHFPick(ctx, newer))
	must(0, s.SaveHFPick(ctx, older))
	samePicks(t, must(s.HFPicks(ctx)), older, newer)

	must(0, s.DeleteHFPick(ctx, older.ID))
	must(0, s.DeleteHFPick(ctx, "hf:none:x")) // no row is not an error
	samePicks(t, must(s.HFPicks(ctx)), newer)
}

func TestHFPicksSavingAnIDAgainKeepsOneRowWithTheNewerFiles(t *testing.T) {
	s := openPicksStore(t, t.TempDir())
	defer s.Close()
	first := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "a.gguf")
	second := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "a.gguf", "mmproj-F16.gguf")
	must(0, s.SaveHFPick(ctx, first))
	must(0, s.SaveHFPick(ctx, second))
	samePicks(t, must(s.HFPicks(ctx)), second)
}

func TestHFPicksSkipARowWhoseFilesDontDecode(t *testing.T) {
	s := openPicksStore(t, t.TempDir())
	defer s.Close()
	good := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "a.gguf")
	must(0, s.SaveHFPick(ctx, good))
	if _, err := s.writer().Exec(`INSERT INTO hf_picks VALUES ('hf:o/r:bad', 'o/r', 'x', 'bad', 'not json', 5)`); err != nil {
		t.Fatal(err)
	}
	samePicks(t, must(s.HFPicks(ctx)), good)
}

func TestHFPicksSurviveReopeningTheStore(t *testing.T) {
	dir := t.TempDir()
	s := openPicksStore(t, dir)
	p := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "a.gguf")
	must(0, s.SaveHFPick(ctx, p))
	s.Close()

	s = openPicksStore(t, dir)
	defer s.Close()
	samePicks(t, must(s.HFPicks(ctx)), p)
}

func TestMigration0010AddsPicksAndLeavesOtherTables(t *testing.T) {
	dir := t.TempDir()
	old, err := open(dir, event.NewBus(16), embeddedUpTo(t, 9), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.ConfigPut(ctx, "other", 0, []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	old.Close()

	s := openPicksStore(t, dir)
	defer s.Close()
	if rev, v, err := s.ConfigGet(ctx, "other"); err != nil || rev != 1 || string(v) != `{"a":1}` {
		t.Fatalf("config = %d, %q, %v", rev, v, err)
	}
	samePicks(t, must(s.HFPicks(ctx)))
	p := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "a.gguf")
	must(0, s.SaveHFPick(ctx, p))
	samePicks(t, must(s.HFPicks(ctx)), p)
}

func TestHFPicksReadOnlyStoreRefusesWrites(t *testing.T) {
	migration, err := os.ReadFile("migrations/0010_hf_downloads.sql")
	if err != nil {
		t.Fatal(err)
	}
	p := pickFixture("hf:o/r:Q4_K_M", time.UnixMilli(1000), "a.gguf")
	s := readOnlyConfigStore(t, func(s *Store) {
		if _, err := s.writer().Exec(string(migration)); err != nil {
			t.Fatal(err)
		}
		must(0, s.SaveHFPick(ctx, p))
	})
	if err := s.SaveHFPick(ctx, p); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("save: %v", err)
	}
	if err := s.DeleteHFPick(ctx, p.ID); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("delete: %v", err)
	}
	samePicks(t, must(s.HFPicks(ctx)), p)
}
