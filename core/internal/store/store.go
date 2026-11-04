// Package store is OpenVatra's own database (chats.db): SQLite through a pure-Go driver, so no C compiler is needed.
package store

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations/*.sql
var embedded embed.FS

// FileName is the database file inside the data folder.
const FileName = "chats.db"

// ErrNewer is wrapped by ReadOnly's error: the database was written by a newer OpenVatra.
var ErrNewer = errors.New("database is newer than this version")

// Store owns the connections. Writes go through one connection so they never fight over SQLite's single write lock;
// reads use a small pool of their own, which WAL lets run beside the writer.
type Store struct {
	w, r     *sql.DB
	readOnly error
}

// Open creates the data folder if needed, opens chats.db inside it and brings it up to date. A database from a newer
// version is opened read-only instead (see ReadOnly): a downgrade must never rewrite data it doesn't understand.
func Open(dir string) (*Store, error) {
	return open(dir, embedded, "migrations")
}

func open(dir string, migrations fs.FS, root string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data folder: %w", err)
	}
	path := filepath.Join(dir, FileName)

	steps, err := load(migrations, root)
	if err != nil {
		return nil, err
	}
	w, err := connect(path, false)
	if err != nil {
		return nil, err
	}
	current, err := version(w)
	if err != nil {
		w.Close()
		return nil, err
	}

	s := &Store{w: w}
	if current > len(steps) {
		// Reopen with writes switched off at the SQLite level, so even a bug can't modify the newer data.
		w.Close()
		if s.w, err = connect(path, true); err != nil {
			return nil, err
		}
		s.readOnly = fmt.Errorf("%w: it was saved by schema version %d and this version knows %d; "+
			"update OpenVatra to use your chats again", ErrNewer, current, len(steps))
	} else if err := migrate(w, steps, current); err != nil {
		w.Close()
		return nil, err
	}

	if s.r, err = connect(path, s.readOnly != nil); err != nil {
		s.w.Close()
		return nil, err
	}
	s.w.SetMaxOpenConns(1)
	s.r.SetMaxOpenConns(4)
	return s, nil
}

// connect opens a pool on the file. The pragmas ride in the DSN so every new connection gets them: a pragma run once
// with Exec would only reach the one connection that happened to serve it.
func connect(path string, readOnly bool) (*sql.DB, error) {
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)") // SQLite ignores foreign keys unless asked, per connection
	q.Add("_pragma", "busy_timeout(5000)")
	if readOnly {
		q.Add("_pragma", "query_only(1)")
	} else {
		// WAL: writes go to a side log, so readers never wait for the writer (and the writer never waits for readers).
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)") // safe with WAL; a power cut can lose the last commit, never corrupt
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+q.Encode())
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := db.Ping(); err != nil { // opens the first connection now, so a bad path fails here
		db.Close()
		return nil, fmt.Errorf("open database: %w", err)
	}
	return db, nil
}

// Close closes both pools.
func (s *Store) Close() error {
	return errors.Join(s.r.Close(), s.w.Close())
}

// ReadOnly is nil normally, or an explanation fit to show the user when the database is newer than this version.
func (s *Store) ReadOnly() error { return s.readOnly }

// Version is the schema version in the file (PRAGMA user_version).
func (s *Store) Version() (int, error) { return version(s.r) }

// reader and writer are for the query code in this package; callers outside use the store's functions.
func (s *Store) reader() *sql.DB { return s.r }
func (s *Store) writer() *sql.DB { return s.w }

// load reads "0001_name.sql", "0002_name.sql", ... in order. Numbers must run 1, 2, 3 with no gaps: the position is
// the schema version, so a gap would silently skip a migration on old databases.
func load(fsys fs.FS, root string) ([]string, error) {
	entries, err := fs.ReadDir(fsys, root)
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	steps := make([]string, 0, len(names))
	for i, name := range names {
		num, _, _ := strings.Cut(name, "_")
		if n, err := strconv.Atoi(num); err != nil || n != i+1 {
			return nil, fmt.Errorf("migration %q: expected number %d", name, i+1)
		}
		body, err := fs.ReadFile(fsys, root+"/"+name)
		if err != nil {
			return nil, err
		}
		steps = append(steps, string(body))
	}
	return steps, nil
}

func version(db *sql.DB) (int, error) {
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return 0, fmt.Errorf("read schema version: %w", err)
	}
	return v, nil
}

// migrate applies every step after `current`, each in its own transaction together with the version bump, so a
// failure leaves the database exactly at the last good version.
func migrate(db *sql.DB, steps []string, current int) error {
	for i := current; i < len(steps); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(steps[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		// PRAGMA can't take a bound parameter; i+1 is an int we computed, so formatting it in is safe.
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	return nil
}
