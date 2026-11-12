package event

import (
	"cmp"
	"slices"
	"sync"
)

type retainedKey struct{ stream, typ string }

type subscriber struct {
	filter Filter
	ch     chan Event
}

// Bus fans events out to subscribers in process and keeps the newest Retained event per (stream, type).
// One mutex guards both, so a subscriber's retained values and its first live event can never cross.
type Bus struct {
	buffer   int
	mu       sync.Mutex
	retained map[retainedKey]Event
	subs     map[*subscriber]struct{}
}

// NewBus makes a bus whose subscribers each get a channel of buffer events (at least 1).
func NewBus(buffer int) *Bus {
	if buffer < 1 {
		panic("event: bus buffer must be at least 1")
	}
	return &Bus{buffer: buffer, retained: map[retainedKey]Event{}, subs: map[*subscriber]struct{}{}}
}

// Publish fans events out without blocking. A Retained event also replaces the kept value for its (stream, type).
// A subscriber whose buffer is full has fallen behind: its channel is closed and it is removed.
func (b *Bus) Publish(events ...Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, e := range events {
		if e.Class() == Retained {
			b.retained[retainedKey{e.Stream, e.Type}] = e
		}
		for s := range b.subs {
			if !s.filter.Match(e.Stream) {
				continue
			}
			select {
			case s.ch <- e:
			default:
				delete(b.subs, s)
				close(s.ch)
			}
		}
	}
}

// Subscribe returns the kept retained values matching f and a channel of everything published after, taken under
// one lock: no retained value can be newer than the first live event. When a subscriber's buffer is full the bus
// closes its channel (the subscriber fell behind); cancel is safe to call after that and twice.
func (b *Bus) Subscribe(f Filter) (retained []Event, events <-chan Event, cancel func()) {
	s := &subscriber{filter: f, ch: make(chan Event, b.buffer)}

	b.mu.Lock()
	for _, e := range b.retained {
		if f.Match(e.Stream) {
			retained = append(retained, e)
		}
	}
	b.subs[s] = struct{}{}
	b.mu.Unlock()

	slices.SortFunc(retained, func(x, y Event) int {
		return cmp.Or(cmp.Compare(x.Stream, y.Stream), cmp.Compare(x.Type, y.Type))
	})
	cancel = func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, ok := b.subs[s]; ok {
			delete(b.subs, s)
			close(s.ch)
		}
	}
	return retained, s.ch, cancel
}
