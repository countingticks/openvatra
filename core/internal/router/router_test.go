package router

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeBackend records what the router does to it.
type fakeBackend struct {
	id      string
	events  *eventLog
	startFn func() error // nil means start succeeds at once
}

func (f *fakeBackend) Start(context.Context, time.Duration) error {
	f.events.add("start " + f.id)
	if f.startFn != nil {
		return f.startFn()
	}
	return nil
}
func (f *fakeBackend) Stop(time.Duration) { f.events.add("stop " + f.id) }
func (f *fakeBackend) BaseURL() string    { return "http://" + f.id }

type eventLog struct {
	mu sync.Mutex
	l  []string
}

func (e *eventLog) add(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.l = append(e.l, s)
}

func (e *eventLog) get() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.l...)
}

func newTestRouter(events *eventLog, startFn func(id string) func() error) *Router {
	return New(Config{
		NewBackend: func(id string, _ bool) (Backend, error) {
			if id == "missing" {
				return nil, ErrUnknownModel
			}
			b := &fakeBackend{id: id, events: events}
			if startFn != nil {
				b.startFn = startFn(id)
			}
			return b, nil
		},
		EmbeddingModel: func() string { return "embed" },
		LoadTimeout:    time.Second,
	})
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSameModelLoadsOnce(t *testing.T) {
	ev := &eventLog{}
	r := newTestRouter(ev, nil)

	for range 3 {
		url, release, err := r.Acquire(context.Background(), Chat, "a")
		if err != nil || url != "http://a" {
			t.Fatalf("Acquire = %q, %v", url, err)
		}
		release()
	}
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events = %v", got)
	}
}

func TestSwapStopsOldAfterItsRequestsFinish(t *testing.T) {
	ev := &eventLog{}
	r := newTestRouter(ev, nil)

	_, releaseA, err := r.Acquire(context.Background(), Chat, "a")
	if err != nil {
		t.Fatal(err)
	}

	swapped := make(chan error, 1)
	go func() {
		_, release, err := r.Acquire(context.Background(), Chat, "b")
		if err == nil {
			release()
		}
		swapped <- err
	}()

	// "a" still has a request in flight, so it must not be stopped yet.
	select {
	case <-swapped:
		t.Fatal("swap finished while the old model was still serving")
	case <-time.After(100 * time.Millisecond):
	}
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events before release = %v", got)
	}

	releaseA()
	if err := <-swapped; err != nil {
		t.Fatal(err)
	}
	if got := ev.get(); !equal(got, []string{"start a", "stop a", "start b"}) {
		t.Fatalf("events = %v", got)
	}
}

func TestRequestsWaitWhileLoading(t *testing.T) {
	ev := &eventLog{}
	gate := make(chan struct{})
	r := newTestRouter(ev, func(string) func() error {
		return func() error { <-gate; return nil }
	})

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, release, err := r.Acquire(context.Background(), Chat, "a")
			if err == nil {
				release()
			}
			results <- err
		}()
	}
	time.Sleep(100 * time.Millisecond)
	select {
	case <-results:
		t.Fatal("a request returned before the model was ready")
	default:
	}

	close(gate)
	wg.Wait()
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("two waiters caused events %v, want one start", got)
	}
}

func TestCancelledWaiterDoesNotAbortTheLoad(t *testing.T) {
	ev := &eventLog{}
	gate := make(chan struct{})
	r := newTestRouter(ev, func(string) func() error {
		return func() error { <-gate; return nil }
	})

	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, _, err := r.Acquire(ctx, Chat, "a")
		first <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	close(gate)
	_, release, err := r.Acquire(context.Background(), Chat, "a")
	if err != nil {
		t.Fatalf("second request failed: %v", err)
	}
	release()
}

func TestFailedLoadIsRetried(t *testing.T) {
	ev := &eventLog{}
	calls := 0
	r := newTestRouter(ev, func(string) func() error {
		return func() error {
			calls++
			if calls == 1 {
				return errors.New("boom")
			}
			return nil
		}
	})

	if _, _, err := r.Acquire(context.Background(), Chat, "a"); err == nil {
		t.Fatal("first load should fail")
	}
	_, release, err := r.Acquire(context.Background(), Chat, "a")
	if err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	release()
}

func TestUnknownModelKeepsCurrentRunning(t *testing.T) {
	ev := &eventLog{}
	r := newTestRouter(ev, nil)

	_, release, _ := r.Acquire(context.Background(), Chat, "a")
	release()
	if _, _, err := r.Acquire(context.Background(), Chat, "missing"); !errors.Is(err, ErrUnknownModel) {
		t.Fatalf("err = %v, want ErrUnknownModel", err)
	}
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events = %v; the running model must not be stopped", got)
	}
}

func TestEmbeddingUsesItsOwnSlotAndIgnoresBodyModel(t *testing.T) {
	ev := &eventLog{}
	r := newTestRouter(ev, nil)

	_, rc, _ := r.Acquire(context.Background(), Chat, "a")
	defer rc()
	url, re, err := r.Acquire(context.Background(), Embedding, "whatever")
	if err != nil || url != "http://embed" {
		t.Fatalf("Acquire = %q, %v", url, err)
	}
	re()
	if got := ev.get(); !equal(got, []string{"start a", "start embed"}) {
		t.Fatalf("events = %v; chat model must stay loaded", got)
	}
}

func TestNoEmbeddingModelChosen(t *testing.T) {
	r := New(Config{EmbeddingModel: func() string { return "" }})
	if _, _, err := r.Acquire(context.Background(), Embedding, ""); !errors.Is(err, ErrNoEmbeddingModel) {
		t.Fatalf("err = %v", err)
	}
}

func TestCloseStopsEverything(t *testing.T) {
	ev := &eventLog{}
	r := newTestRouter(ev, nil)
	_, ra, _ := r.Acquire(context.Background(), Chat, "a")
	ra()
	_, re, _ := r.Acquire(context.Background(), Embedding, "")
	re()

	r.Close()
	got := ev.get()
	if len(got) != 4 || got[2] == got[3] {
		t.Fatalf("events = %v, want both servers stopped", got)
	}
}
