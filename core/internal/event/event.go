// Package event holds the envelope, the typed payloads, stream filters, the in-process bus and the Log interface.
// It uses only the standard library and never imports store: the store builds its log on these types.
package event

import (
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

// Class says how an event travels.
type Class int

const (
	Durable   Class = iota + 1 // stored before it is published; has a seq
	Ephemeral                  // published only; may be lost
	Retained                   // published only; the bus keeps the newest per (stream, type) for new subscribers
)

// Type describes one event type. V is the version of its data shape: it grows by optional fields or a new V.
type Type struct {
	Name  string // dotted: "config.changed"
	V     int    // ≥ 1
	Class Class
}

// Payload is one typed event body; every implementation is a struct in types.go.
type Payload interface{ EventType() Type }

// Event is the envelope, as stored and as sent.
type Event struct {
	Seq    int64           `json:"seq,omitempty"` // 0 (left out) unless durable
	Time   int64           `json:"time"`          // Unix ms
	Stream string          `json:"stream"`        // "system" | "chat:<id>" | "run:<id>"
	Type   string          `json:"type"`
	V      int             `json:"v"`
	Data   json.RawMessage `json:"data"`
	class  Class           // set by New; zero on events read from the table, which are durable
}

var streamPattern = regexp.MustCompile(`^[a-z]+:[A-Za-z0-9-]+$`)

// ValidStream reports whether name is "system" or "<kind>:<id>".
func ValidStream(name string) bool {
	return name == "system" || streamPattern.MatchString(name)
}

// New builds the envelope for p on stream. A bad stream name or a payload that does not marshal is a wiring bug,
// so both panic.
func New(stream string, p Payload, at time.Time) Event {
	if !ValidStream(stream) {
		panic(fmt.Sprintf("event: invalid stream name %q", stream))
	}
	data, err := json.Marshal(p)
	if err != nil {
		panic(fmt.Sprintf("event: marshal payload: %v", err))
	}
	t := p.EventType()
	return Event{Time: at.UnixMilli(), Stream: stream, Type: t.Name, V: t.V, Data: data, class: t.Class}
}

// Class is the event's class; events read back from the table carry none and are durable.
func (e Event) Class() Class {
	if e.class == 0 {
		return Durable
	}
	return e.class
}
