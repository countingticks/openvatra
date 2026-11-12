package event

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Log is the event log: durable events are stored with a seq, the others only go through the bus.
type Log interface {
	// Append stores durable payloads, runs the projectors, commits, then publishes. A non-durable payload panics.
	Append(ctx context.Context, stream string, payloads ...Payload) ([]Event, error)
	// Publish sends an ephemeral or retained payload. A durable payload panics.
	Publish(stream string, p Payload)
	// Read returns stored events with Seq > after matching f, oldest first, at most limit (1–1000).
	Read(ctx context.Context, after int64, f Filter, limit int) ([]Event, error)
	// Subscribe returns the kept retained values matching f and a channel of everything published after.
	Subscribe(f Filter) (retained []Event, events <-chan Event, cancel func())
	// Info is the log's id and the highest seq ever assigned (not the highest still stored).
	Info(ctx context.Context) (Info, error)
}

// Info identifies a log and its head, for the stream's first frame.
type Info struct {
	ID   string `json:"log"` // random, made when the database is created; "" without a database
	Head int64  `json:"head"`
}

// Projector keeps a view table in step with the log, inside the append's transaction.
type Projector interface {
	Apply(tx *sql.Tx, e Event) error
}

// ErrUnavailable means there is no database, or it is read-only.
var ErrUnavailable = errors.New("event log is not available")

const maxReadLimit = 1000

// checkDurable panics unless every payload is durable: Append takes only those.
func checkDurable(payloads []Payload) {
	for _, p := range payloads {
		if t := p.EventType(); t.Class != Durable {
			panic(fmt.Sprintf("event: Append of non-durable %q", t.Name))
		}
	}
}

func checkReadLimit(limit int) {
	if limit < 1 || limit > maxReadLimit {
		panic(fmt.Sprintf("event: Read limit %d outside 1–%d", limit, maxReadLimit))
	}
}

type memoryLog struct{ bus *Bus }

// MemoryLog is the log without a database: Publish and Subscribe work through bus, Append is unavailable and
// nothing is stored. The store's log embeds it so those two rules are written once.
func MemoryLog(bus *Bus) Log {
	if bus == nil {
		panic("event: MemoryLog with a nil bus")
	}
	return memoryLog{bus: bus}
}

func (memoryLog) Append(_ context.Context, _ string, payloads ...Payload) ([]Event, error) {
	checkDurable(payloads)
	return nil, ErrUnavailable
}

func (l memoryLog) Publish(stream string, p Payload) {
	if t := p.EventType(); t.Class == Durable {
		panic(fmt.Sprintf("event: Publish of durable %q", t.Name))
	}
	l.bus.Publish(New(stream, p, time.Now()))
}

func (memoryLog) Read(_ context.Context, _ int64, _ Filter, limit int) ([]Event, error) {
	checkReadLimit(limit)
	return []Event{}, nil
}

func (l memoryLog) Subscribe(f Filter) ([]Event, <-chan Event, func()) {
	return l.bus.Subscribe(f)
}

func (memoryLog) Info(context.Context) (Info, error) { return Info{}, nil }
