package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/countingticks/openvatra/core/internal/event"
)

// migrations builds an in-memory migration folder named m/0001_x.sql, m/0002_x.sql, ...
func migrations(sqls ...string) fstest.MapFS {
	m := fstest.MapFS{}
	for i, s := range sqls {
		m[fmt.Sprintf("m/%04d_x.sql", i+1)] = &fstest.MapFile{Data: []byte(s)}
	}
	return m
}

func TestOpenEmptyDatabaseCreatesFolderAndMigrates(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "data")
	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatal("database file missing:", err)
	}
	steps, _ := load(embedded, "migrations")
	if v, _ := s.Version(); v != len(steps) || v < 1 {
		t.Fatalf("version = %d, want %d", v, len(steps))
	}
	if s.ReadOnly() != nil {
		t.Fatal("fresh database must be writable")
	}
}

func TestPragmasApplyToEveryConnection(t *testing.T) {
	s, err := Open(t.TempDir(), event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var mode string
	if err := s.writer().QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v", mode, err)
	}
	var fk int
	if err := s.reader().QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign_keys = %d, %v", fk, err)
	}
}

func TestOldDatabaseGetsOnlyTheNewMigrations(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer().Exec("INSERT INTO a VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)", "CREATE TABLE b(y)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.Version(); v != 2 {
		t.Fatalf("version = %d, want 2", v)
	}
	var n int
	if err := s.reader().QueryRow("SELECT count(*) FROM a").Scan(&n); err != nil || n != 1 {
		t.Fatalf("old data lost: n=%d err=%v", n, err)
	}
	if _, err := s.writer().Exec("INSERT INTO b VALUES (1)"); err != nil {
		t.Fatal("new table missing:", err)
	}
}

func TestFailedMigrationLeavesVersionUntouched(t *testing.T) {
	dir := t.TempDir()
	if _, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)", "THIS IS NOT SQL"), "m"); err == nil {
		t.Fatal("want an error")
	}
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.Version(); v != 1 {
		t.Fatalf("version = %d, want 1", v)
	}
}

func TestNewerDatabaseOpensReadOnly(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)", "CREATE TABLE b(y)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m") // an older app
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !errors.Is(s.ReadOnly(), ErrNewer) {
		t.Fatalf("ReadOnly = %v", s.ReadOnly())
	}
	if _, err := s.writer().Exec("INSERT INTO a VALUES (1)"); err == nil {
		t.Fatal("write must be refused")
	}
	if v, _ := s.Version(); v != 2 {
		t.Fatalf("version changed to %d", v)
	}
}

func TestLoadRejectsGapsInNumbering(t *testing.T) {
	m := fstest.MapFS{
		"m/0001_a.sql": {Data: []byte("")},
		"m/0003_c.sql": {Data: []byte("")},
	}
	if _, err := load(m, "m"); err == nil {
		t.Fatal("want an error for a gap")
	}
}

// crashCopy writes a row in dir A with auto-checkpointing off, then copies the database and its WAL into a new
// folder while A is still open, so the row lives only in the WAL, as after a crash.
func crashCopy(t *testing.T, name string) string {
	t.Helper()
	a, b := t.TempDir(), t.TempDir()
	s, err := open(a, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if _, err := s.writer().Exec("PRAGMA wal_autocheckpoint=0"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer().Exec("INSERT INTO a VALUES (42)"); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{FileName, FileName + "-wal"} {
		data, err := os.ReadFile(filepath.Join(a, f))
		if err != nil {
			t.Fatal(err)
		}
		dst := name + strings.TrimPrefix(f, FileName)
		if err := os.WriteFile(filepath.Join(b, dst), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return b
}

func TestLegacyDatabaseWithWalIsRenamed(t *testing.T) {
	dir := crashCopy(t, legacyFileName)
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.RenameErr() != nil {
		t.Fatal(s.RenameErr())
	}
	var x int
	if err := s.reader().QueryRow("SELECT x FROM a").Scan(&x); err != nil || x != 42 {
		t.Fatalf("row = %d, %v", x, err)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatal("openvatra.db missing:", err)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "chats.db*"))
	if len(left) != 0 {
		t.Fatalf("old files left: %v", left)
	}
}

func TestExistingNewNameWinsOverLegacy(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	legacy := filepath.Join(dir, legacyFileName)
	if err := os.WriteFile(legacy, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err = open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	got, err := os.ReadFile(legacy)
	if err != nil || string(got) != "not a database" {
		t.Fatalf("chats.db was touched: %q, %v", got, err)
	}
}

func TestNewerLegacyDatabaseIsRenamedAndReadOnly(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)", "CREATE TABLE b(y)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if err := os.Rename(filepath.Join(dir, FileName), filepath.Join(dir, legacyFileName)); err != nil {
		t.Fatal(err)
	}
	s, err = open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !errors.Is(s.ReadOnly(), ErrNewer) {
		t.Fatalf("ReadOnly = %v", s.ReadOnly())
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatal("not renamed:", err)
	}
}

func TestFailedRenameKeepsLegacyDatabase(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer().Exec("INSERT INTO a VALUES (7)"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if err := os.Rename(filepath.Join(dir, FileName), filepath.Join(dir, legacyFileName)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, FileName), 0o700); err != nil {
		t.Fatal(err)
	}
	s, err = open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.RenameErr() == nil {
		t.Fatal("want a rename error")
	}
	var x int
	if err := s.reader().QueryRow("SELECT x FROM a").Scan(&x); err != nil || x != 7 {
		t.Fatalf("row = %d, %v", x, err)
	}
}

func TestEmptyFolderGetsNewName(t *testing.T) {
	dir := t.TempDir()
	s, err := open(dir, event.NewBus(16), migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.RenameErr() != nil {
		t.Fatal(s.RenameErr())
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatal(err)
	}
}
