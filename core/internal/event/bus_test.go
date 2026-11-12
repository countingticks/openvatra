package event

import (
	"encoding/json"
	"math/rand/v2"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// tick is an ephemeral test payload.
type tick struct {
	N int `json:"n"`
}

func (tick) EventType() Type { return Type{Name: "test.tick", V: 1, Class: Ephemeral} }

// counter is a retained test payload.
type counter struct {
	N int `json:"n"`
}

func (counter) EventType() Type { return Type{Name: "test.counter", V: 1, Class: Retained} }

// gauge is a second retained test payload, to show types on one stream are kept apart.
type gauge struct {
	N int `json:"n"`
}

func (gauge) EventType() Type { return Type{Name: "test.gauge", V: 1, Class: Retained} }

func ev(stream string, p Payload) Event { return New(stream, p, time.UnixMilli(0)) }

func mustFilter(t *testing.T, s string) Filter {
	t.Helper()
	f, err := ParseFilter(s)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// next waits up to 2s for the next event; ok is false when the channel closed or nothing came.
func next(ch <-chan Event) (e Event, ok bool, timedOut bool) {
	select {
	case e, ok := <-ch:
		return e, ok, false
	case <-time.After(2 * time.Second):
		return Event{}, false, true
	}
}

func recv(t *testing.T, ch <-chan Event) (Event, bool) {
	t.Helper()
	e, ok, timedOut := next(ch)
	if timedOut {
		t.Fatal("no event within 2s")
	}
	return e, ok
}

// pending returns what is buffered on ch without waiting, and whether ch is closed.
func pending(ch <-chan Event) (got []string, closed bool) {
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return got, true
			}
			got = append(got, describe(e))
		default:
			return got, false
		}
	}
}

func describe(e Event) string { return e.Stream + " " + e.Type + " " + string(e.Data) }

func describeAll(events []Event) []string {
	var out []string
	for _, e := range events {
		out = append(out, describe(e))
	}
	return out
}

func TestBusDeliversOnlyMatchingStreams(t *testing.T) {
	b := NewBus(8)
	_, ch, cancel := b.Subscribe(mustFilter(t, "chat:*"))
	defer cancel()

	b.Publish(ev("system", tick{1}), ev("chat:a", tick{2}), ev("run:a", tick{3}), ev("chat:b", tick{4}))

	got, _ := pending(ch)
	want := []string{`chat:a test.tick {"n":2}`, `chat:b test.tick {"n":4}`}
	if !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestBusDeliversToEverySubscriber(t *testing.T) {
	b := NewBus(8)
	_, ch1, cancel1 := b.Subscribe(Filter{})
	defer cancel1()
	_, ch2, cancel2 := b.Subscribe(Filter{})
	defer cancel2()

	b.Publish(ev("system", tick{1}))

	for i, ch := range []<-chan Event{ch1, ch2} {
		if e, ok := recv(t, ch); !ok || string(e.Data) != `{"n":1}` {
			t.Errorf("subscriber %d got %+v, open %v", i, e, ok)
		}
	}
}

func TestBusRetainsNewestValuePerStreamAndType(t *testing.T) {
	b := NewBus(8)
	b.Publish(
		ev("system", counter{1}),
		ev("system", counter{2}),
		ev("system", gauge{3}),
		ev("chat:a", counter{4}),
	)
	b.Publish(ev("chat:a", counter{5}))

	tests := []struct {
		name   string
		filter string
		want   []string
	}{
		{"everything", "", []string{
			`chat:a test.counter {"n":5}`,
			`system test.counter {"n":2}`,
			`system test.gauge {"n":3}`,
		}},
		{"filtered", "system", []string{
			`system test.counter {"n":2}`,
			`system test.gauge {"n":3}`,
		}},
		{"no match", "run:*", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			retained, _, cancel := b.Subscribe(mustFilter(t, tt.filter))
			cancel()
			if got := describeAll(retained); !slices.Equal(got, tt.want) {
				t.Errorf("retained = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBusDoesNotRetainEphemeralOrDurable(t *testing.T) {
	b := NewBus(8)
	b.Publish(ev("system", tick{1}), ev("system", ConfigChanged{Section: "models", Rev: 2}))

	retained, _, cancel := b.Subscribe(Filter{})
	cancel()
	if len(retained) != 0 {
		t.Errorf("retained = %v, want none", describeAll(retained))
	}
}

func TestBusClosesSubscriberThatFallsBehind(t *testing.T) {
	b := NewBus(2)
	_, slow, cancelSlow := b.Subscribe(Filter{})
	_, fast, cancelFast := b.Subscribe(Filter{})
	defer cancelFast()

	var got []string
	for i := 1; i <= 3; i++ {
		b.Publish(ev("system", tick{i}))
		e, ok := recv(t, fast)
		if !ok {
			t.Fatal("reading subscriber was closed")
		}
		got = append(got, string(e.Data))
	}
	if want := []string{`{"n":1}`, `{"n":2}`, `{"n":3}`}; !slices.Equal(got, want) {
		t.Errorf("reading subscriber got %v, want %v", got, want)
	}

	buffered, closed := pending(slow)
	if !closed || len(buffered) != 2 {
		t.Errorf("slow subscriber: buffered %v, closed %v; want 2 events then closed", buffered, closed)
	}
	cancelSlow()
	cancelSlow()
}

func TestBusCancelClosesChannel(t *testing.T) {
	b := NewBus(2)
	_, ch, cancel := b.Subscribe(Filter{})
	cancel()
	if _, ok := recv(t, ch); ok {
		t.Error("channel still open after cancel")
	}
	cancel()
	b.Publish(ev("system", tick{1}))
}

// Wherever Subscribe lands between two publishes, the retained value and then the live values a subscriber sees
// must be strictly increasing (decision 10: a stress test, since -race is not available).
func TestBusSubscribeIsAtomicWithPublish(t *testing.T) {
	const last, subscribers = 2000, 50
	b := NewBus(64)
	var published atomic.Int64

	var wg sync.WaitGroup
	for i := range subscribers {
		start := rand.Int64N(last)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for published.Load() < start {
				runtime.Gosched()
			}
			retained, ch, cancel := b.Subscribe(Filter{})
			defer cancel()

			var seen []int
			for _, e := range retained {
				seen = append(seen, counterValue(t, e))
			}
			closed := false
			for len(seen) == 0 || seen[len(seen)-1] < last {
				e, ok, timedOut := next(ch)
				if timedOut {
					t.Errorf("subscriber %d: no event within 2s after %v", i, seen[max(0, len(seen)-3):])
					return
				}
				if !ok {
					closed = true
					break
				}
				seen = append(seen, counterValue(t, e))
			}
			for j := 1; j < len(seen); j++ {
				if seen[j] <= seen[j-1] {
					t.Errorf("subscriber %d saw %d after %d", i, seen[j], seen[j-1])
					return
				}
				// A subscriber the bus never closed also missed nothing between its retained value and the end.
				if !closed && seen[j] != seen[j-1]+1 {
					t.Errorf("subscriber %d saw %d after %d: a gap", i, seen[j], seen[j-1])
					return
				}
			}
		}()
	}

	for n := 1; n <= last; n++ {
		b.Publish(ev("system", counter{n}))
		published.Store(int64(n))
		runtime.Gosched()
	}
	wg.Wait()
}

func counterValue(t *testing.T, e Event) int {
	var c counter
	if err := json.Unmarshal(e.Data, &c); err != nil {
		t.Errorf("bad counter data %s: %v", e.Data, err)
	}
	return c.N
}
