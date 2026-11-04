package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
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
	s, err := Open(dir)
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
	s, err := Open(t.TempDir())
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
	s, err := open(dir, migrations("CREATE TABLE a(x)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.writer().Exec("INSERT INTO a VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = open(dir, migrations("CREATE TABLE a(x)", "CREATE TABLE b(y)"), "m")
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
	if _, err := open(dir, migrations("CREATE TABLE a(x)", "THIS IS NOT SQL"), "m"); err == nil {
		t.Fatal("want an error")
	}
	s, err := open(dir, migrations("CREATE TABLE a(x)"), "m")
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
	s, err := open(dir, migrations("CREATE TABLE a(x)", "CREATE TABLE b(y)"), "m")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = open(dir, migrations("CREATE TABLE a(x)"), "m") // an older app
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
