package config

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"

	"github.com/countingticks/openvatra/core/internal/store"
)

var (
	ErrUnknownSection = errors.New("unknown config section")
	ErrConflict       = errors.New("config revision conflict")
	ErrUnavailable    = errors.New("config storage is not available")
)

// InvalidError is a value that did not decode or validate; Message is one sentence naming the field.
type InvalidError struct{ Message string }

func (e *InvalidError) Error() string { return e.Message }

// Validator is what every section type implements: it rejects values core must not act on.
type Validator interface{ Validate() error }

// DB is the part of *store.Store the config store uses. nil = no database.
type DB interface {
	ConfigGet(ctx context.Context, section string) (int, []byte, error)
	ConfigPut(ctx context.Context, section string, expectRev int, value []byte) (int, error)
}

// SectionEntry is one section as clients see it.
type SectionEntry struct {
	Rev       int             `json:"rev"` // 0 = never written; value is the defaults
	Value     json.RawMessage `json:"value"`
	Effective json.RawMessage `json:"effective,omitempty"` // resolved values, read-only; per section
}

// SectionType describes one registered section for the API. Effective is nil when the section has none.
type SectionType struct {
	Name             string
	Value, Effective reflect.Type
	ShellOnly        []string // nil when the section has none
}

// ShellOnlyFields is implemented by a section whose listed JSON fields only the shell token may set.
type ShellOnlyFields interface{ ShellOnly() []string }

// section is one registered section. value is always a T; decode and effective are typed closures made by Register.
type section struct {
	typ       reflect.Type
	effType   reflect.Type // nil = no effective values
	rev       int
	value     any
	raw       []byte // json.Marshal(value), so Section doesn't marshal it again
	decode    func(data []byte) (any, error)
	effective func(any) any // nil = none
	shellOnly []string
}

// Store holds every section. Reads take only mu; Puts run one at a time under putMu, so a slow disk never blocks a
// reader.
type Store struct {
	db     DB
	logger *slog.Logger

	putMu    sync.Mutex // one Put at a time, from decode to cache update
	mu       sync.RWMutex
	sections map[string]*section
	order    []string // section names in registration order

	notifyMu sync.Mutex // keeps subscribers called in commit order
	subsMu   sync.Mutex
	subs     []subscriber
	nextSub  int
}

type subscriber struct {
	id int
	fn func(section string, rev int)
}

// New makes an empty store. Without a database (db nil) sections serve their defaults and Put returns
// ErrUnavailable.
func New(db DB, logger *slog.Logger) *Store {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Store{db: db, logger: logger, sections: map[string]*section{}}
}

// Register adds a section with its defaults and reads its stored value. A stored value that no longer decodes or
// validates is logged and the defaults are used; the row stays until the next accepted Put. effective (nil for none)
// turns the value into the resolved values clients see beside it. Panics on a duplicate name (wiring bug).
func Register[T Validator, E any](s *Store, name string, defaults T, effective func(T) E) {
	sec := &section{
		typ:    reflect.TypeFor[T](),
		decode: func(data []byte) (any, error) { return decodeStrict[T](data) },
	}
	if so, ok := any(defaults).(ShellOnlyFields); ok {
		sec.shellOnly = so.ShellOnly()
	}
	if effective != nil {
		sec.effType = reflect.TypeFor[E]()
		sec.effective = func(v any) any { return effective(v.(T)) }
	}

	value := defaults
	if s.db != nil {
		rev, data, err := s.db.ConfigGet(context.Background(), name)
		switch {
		case err != nil:
			s.logger.Error("config section unreadable; using the defaults", "section", name, "err", err)
		case data != nil:
			sec.rev = rev
			if v, err := decodeStrict[T](data); err != nil {
				s.logger.Error("stored config section is invalid; using the defaults", "section", name, "err", err)
			} else {
				value = v
			}
		}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("config section %q does not marshal: %v", name, err))
	}
	sec.value, sec.raw = value, raw

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.sections[name]; dup {
		panic(fmt.Sprintf("config section %q registered twice", name))
	}
	s.sections[name] = sec
	s.order = append(s.order, name)
}

// Sections lists the registered sections in the order Register was called.
func (s *Store) Sections() []SectionType {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]SectionType, 0, len(s.order))
	for _, name := range s.order {
		sec := s.sections[name]
		out = append(out, SectionType{Name: name, Value: sec.typ, Effective: sec.effType, ShellOnly: sec.shellOnly})
	}
	return out
}

// Get returns the cached value of a section; it never touches the disk. Callers must not modify maps or slices in
// it: they are shared with the cache. Panics for an unknown name or the wrong T (wiring bugs).
func Get[T Validator](s *Store, name string) T {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sec, ok := s.sections[name]
	if !ok {
		panic(fmt.Sprintf("config section %q is not registered", name))
	}
	v, ok := sec.value.(T)
	if !ok {
		panic(fmt.Sprintf("config section %q is a %v, not a %v", name, sec.typ, reflect.TypeFor[T]()))
	}
	return v
}

// Section returns one section's entry, or ErrUnknownSection.
func (s *Store) Section(name string) (SectionEntry, error) {
	s.mu.RLock()
	sec, ok := s.sections[name]
	var rev int
	var value any
	var raw []byte
	if ok {
		rev, value, raw = sec.rev, sec.value, sec.raw
	}
	s.mu.RUnlock()
	if !ok {
		return SectionEntry{}, ErrUnknownSection
	}
	return sec.entry(rev, value, raw), nil
}

// entry builds the SectionEntry outside the lock: effective may look at the disk (the CUDA engine's file).
func (sec *section) entry(rev int, value any, raw []byte) SectionEntry {
	e := SectionEntry{Rev: rev, Value: json.RawMessage(raw)}
	if sec.effective != nil {
		eff, err := json.Marshal(sec.effective(value))
		if err != nil {
			panic(fmt.Sprintf("config effective values do not marshal: %v", err)) // a wiring bug
		}
		e.Effective = eff
	}
	return e
}

// All returns every section's entry.
func (s *Store) All() map[string]SectionEntry {
	s.mu.RLock()
	names := make([]string, 0, len(s.sections))
	for name := range s.sections {
		names = append(names, name)
	}
	s.mu.RUnlock()
	all := make(map[string]SectionEntry, len(names))
	for _, name := range names {
		if e, err := s.Section(name); err == nil {
			all[name] = e
		}
	}
	return all
}

// Put replaces a whole section if rev is still the stored revision: decode strictly, Validate, save, update the
// cache, then notify the subscribers. A rejected Put changes nothing and notifies nobody.
func (s *Store) Put(name string, rev int, value json.RawMessage) (SectionEntry, error) {
	s.putMu.Lock()
	locked := true
	defer func() {
		if locked {
			s.putMu.Unlock()
		}
	}()

	s.mu.RLock()
	sec, ok := s.sections[name]
	s.mu.RUnlock()
	if !ok {
		return SectionEntry{}, ErrUnknownSection
	}
	if s.db == nil {
		return SectionEntry{}, ErrUnavailable
	}
	v, err := sec.decode(value)
	if err != nil {
		return SectionEntry{}, err
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return SectionEntry{}, fmt.Errorf("config put %s: %w", name, err)
	}
	newRev, err := s.db.ConfigPut(context.Background(), name, rev, raw)
	switch {
	case errors.Is(err, store.ErrConflict):
		return SectionEntry{}, ErrConflict
	case errors.Is(err, store.ErrReadOnly):
		return SectionEntry{}, ErrUnavailable
	case err != nil:
		return SectionEntry{}, fmt.Errorf("config put %s: %w", name, err)
	}

	// The notify lock comes before the data lock is released, so a later Put can't notify before this one; it is
	// taken before the data lock, so a subscriber calling Get never waits on a Put that waits on it.
	s.notifyMu.Lock()
	defer s.notifyMu.Unlock()
	s.mu.Lock()
	sec.rev, sec.value, sec.raw = newRev, v, raw
	s.mu.Unlock()
	s.putMu.Unlock()
	locked = false

	for _, sub := range s.subscribers() {
		sub.fn(name, newRev)
	}
	return sec.entry(newRev, v, raw), nil
}

// Subscribe registers fn to be called after every accepted Put, in commit order, on Put's goroutine. fn may call Get
// or Section but not Put. cancel removes it; calling it twice is harmless.
func (s *Store) Subscribe(fn func(section string, rev int)) (cancel func()) {
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	s.nextSub++
	id := s.nextSub
	s.subs = append(s.subs, subscriber{id: id, fn: fn})
	return func() {
		s.subsMu.Lock()
		defer s.subsMu.Unlock()
		for i, sub := range s.subs {
			if sub.id == id {
				s.subs = append(s.subs[:i:i], s.subs[i+1:]...)
				return
			}
		}
	}
}

func (s *Store) subscribers() []subscriber {
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	return append([]subscriber(nil), s.subs...)
}

// decodeStrict decodes data into a zero T, rejecting unknown fields, then validates it. Fields left out keep their
// zero value and are judged by Validate.
func decodeStrict[T Validator](data []byte) (T, error) {
	var v T
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return v, &InvalidError{"the value must be an object"}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &typeErr) && typeErr.Field == "":
			return v, &InvalidError{"the value must be an object"}
		case errors.As(err, &typeErr):
			return v, &InvalidError{typeErr.Field + " has the wrong type"}
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			// encoding/json has no typed error for this one.
			return v, &InvalidError{strings.TrimPrefix(err.Error(), "json: ")}
		default:
			return v, &InvalidError{"the value is not valid JSON"}
		}
	}
	if _, err := dec.Token(); err != io.EOF {
		return v, &InvalidError{"the value is not valid JSON"} // something after the value
	}
	if err := v.Validate(); err != nil {
		return v, &InvalidError{err.Error()}
	}
	return v, nil
}
