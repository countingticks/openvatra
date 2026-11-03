package router

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeClock runs timers only when a test advances time, so idle tests never wait.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers []*fakeTimer
}

type fakeTimer struct {
	at      time.Duration
	f       func()
	stopped bool
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now + d, f: f}
	c.timers = append(c.timers, t)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

// Advance moves time forward and fires the timers that came due.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	var due []*fakeTimer
	for _, t := range c.timers {
		if !t.stopped && t.at <= c.now {
			t.stopped = true
			due = append(due, t)
		}
	}
	c.mu.Unlock()
	for _, t := range due {
		t.f()
	}
}

func newIdleRouter(ev *eventLog, clock *fakeClock) *Router {
	return New(Config{
		NewBackend: func(id string, _ bool) (Backend, error) {
			return &fakeBackend{id: id, events: ev}, nil
		},
		EmbeddingModel: func() string { return "embed" },
		IdleTimeout:    func(string) time.Duration { return 15 * time.Minute },
		AfterFunc:      clock.AfterFunc,
	})
}

// waitFor polls until the events match; stopping happens on a background goroutine.
func waitFor(t *testing.T, ev *eventLog, want ...string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if equal(ev.get(), want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("events = %v, want %v", ev.get(), want)
}

func TestIdleModelIsUnloadedAfterTimeout(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	release()

	clock.Advance(14 * time.Minute)
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("unloaded too early: %v", got)
	}
	clock.Advance(time.Minute)
	waitFor(t, ev, "start a", "stop a")
	if snap := r.Snapshot(); len(snap) != 0 {
		t.Fatalf("snapshot = %v, want empty", snap)
	}
}

func TestTimerRestartsFromTheLastFinishedRequest(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	release()
	clock.Advance(10 * time.Minute)
	_, release, _ = r.Acquire(context.Background(), Chat, "a")
	release()

	clock.Advance(10 * time.Minute) // 20 minutes since the first request, 10 since the last
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events = %v; the second request should have restarted the timer", got)
	}
	clock.Advance(5 * time.Minute)
	waitFor(t, ev, "start a", "stop a")
}

func TestBusyModelIsNeverUnloaded(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	clock.Advance(time.Hour) // a long stream: no timer may run while it is open
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events = %v", got)
	}
	if snap := r.Snapshot(); len(snap) != 1 || !snap[0].Busy {
		t.Fatalf("snapshot = %v, want one busy model", snap)
	}
	release()
	clock.Advance(15 * time.Minute)
	waitFor(t, ev, "start a", "stop a")
}

func TestIdleTimeoutZeroMeansNever(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)
	r.cfg.IdleTimeout = func(string) time.Duration { return 0 }

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	release()
	clock.Advance(24 * time.Hour)
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events = %v", got)
	}
}

func TestIdleTimeoutIsPerModel(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)
	r.cfg.IdleTimeout = func(id string) time.Duration {
		if id == "embed" {
			return time.Hour
		}
		return 5 * time.Minute
	}

	_, releaseChat, _ := r.Acquire(context.Background(), Chat, "a")
	_, releaseEmbed, _ := r.Acquire(context.Background(), Embedding, "embed")
	releaseChat()
	releaseEmbed()
	clock.Advance(5 * time.Minute)
	waitFor(t, ev, "start a", "start embed", "stop a")
	clock.Advance(55 * time.Minute)
	waitFor(t, ev, "start a", "start embed", "stop a", "stop embed")
}

func TestReloadAfterIdleUnload(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	release()
	clock.Advance(15 * time.Minute)
	waitFor(t, ev, "start a", "stop a")

	_, release, err := r.Acquire(context.Background(), Chat, "a")
	if err != nil {
		t.Fatal(err)
	}
	release()
	waitFor(t, ev, "start a", "stop a", "start a")
}

func TestManualLoadAndUnload(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)

	if err := r.Load(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if snap := r.Snapshot(); len(snap) != 1 || snap[0].State != StateReady || snap[0].Busy {
		t.Fatalf("snapshot = %v", snap)
	}
	if !r.Unload("a") {
		t.Fatal("Unload reported the model as not loaded")
	}
	waitFor(t, ev, "start a", "stop a")
	if r.Unload("a") {
		t.Fatal("second Unload should report not loaded")
	}
}

func TestSnapshotReportsLoadingAndFailure(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	gate := make(chan struct{})
	r := New(Config{
		NewBackend: func(id string, _ bool) (Backend, error) {
			return &fakeBackend{id: id, events: ev, startFn: func() error {
				<-gate
				return errors.New("boom")
			}}, nil
		},
		EmbeddingModel: func() string { return "" },
		AfterFunc:      clock.AfterFunc,
	})

	go func() { _, _, _ = r.Acquire(context.Background(), Chat, "a") }()
	deadline := time.Now().Add(2 * time.Second)
	for len(r.Snapshot()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if snap := r.Snapshot(); len(snap) != 1 || snap[0].State != StateLoading {
		t.Fatalf("snapshot = %v, want loading", snap)
	}
	close(gate)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if snap := r.Snapshot(); len(snap) == 1 && snap[0].State == StateError {
			if snap[0].Error == "" {
				t.Fatal("error state without a message")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("snapshot = %v, want error", r.Snapshot())
}

func TestSubscribersAreSignalledOnChange(t *testing.T) {
	ev, clock := &eventLog{}, &fakeClock{}
	r := newIdleRouter(ev, clock)
	ch, cancel := r.Subscribe()
	defer cancel()

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	release()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("no signal after a load")
	}
}
