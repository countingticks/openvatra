package feed

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

func twoModels() ([]models.Model, error) {
	return []models.Model{
		{ID: "a", SizeBytes: 10, Kind: models.KindEmbedding},
		{ID: "b", SizeBytes: 20, MMProj: `D:\m\mmproj-b.gguf`, Kind: models.KindChat},
		{ID: "c", SizeBytes: 5, Kind: models.KindUnreadable, Error: "not a GGUF file"},
	}, nil
}

// stubRouter has a settable snapshot and a channel the test sends signals on.
type stubRouter struct {
	mu       sync.Mutex
	snapshot []router.ModelState
	changes  chan struct{}
}

func (s *stubRouter) Snapshot() []router.ModelState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshot
}
func (s *stubRouter) set(m ...router.ModelState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot = m
}
func (s *stubRouter) Subscribe() (<-chan struct{}, func()) { return s.changes, func() {} }

func newLog() event.Log { return event.MemoryLog(event.NewBus(16)) }

func subscribe(t *testing.T, log event.Log) ([]event.Event, <-chan event.Event) {
	t.Helper()
	f, err := event.ParseFilter("system")
	if err != nil {
		t.Fatal(err)
	}
	retained, ch, cancel := log.Subscribe(f)
	t.Cleanup(cancel)
	return retained, ch
}

func next(t *testing.T, ch <-chan event.Event) event.Event {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("no event")
		return event.Event{}
	}
}

// waitRetained polls for the retained value of typ, which Start publishes from its goroutine.
func waitRetained(t *testing.T, log event.Log, typ string) event.Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		retained, _ := subscribe(t, log)
		for _, e := range retained {
			if e.Type == typ {
				return e
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no retained %s", typ)
	return event.Event{}
}

func modelsIn(t *testing.T, e event.Event) []map[string]any {
	t.Helper()
	var d struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(e.Data, &d); err != nil {
		t.Fatal(err)
	}
	return d.Models
}

func TestStateMergesRouterWithDiscoveredModels(t *testing.T) {
	rt := &stubRouter{snapshot: []router.ModelState{{ID: "b", State: router.StateReady, Busy: true}}}
	body, err := State(rt, twoModels)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(body)
	want := `{"models":[{"id":"a","state":"stopped","busy":false,"sizeBytes":10,"kind":"embedding"},{"id":"b","state":"ready","busy":true,"sizeBytes":20,"projector":"mmproj-b.gguf","kind":"chat"},{"id":"c","state":"stopped","busy":false,"sizeBytes":5,"kind":"unreadable","error":"not a GGUF file"}]}`
	if strings.TrimSpace(string(got)) != want {
		t.Fatalf("body = %s\nwant   %s", got, want)
	}
}

func TestStartPublishesModelStateRetained(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	ctx := t.Context()
	Start(ctx, log, rt, twoModels, nil)

	e := waitRetained(t, log, "model.state")
	if e.Stream != "system" || e.V != 1 || len(modelsIn(t, e)) != 3 {
		t.Fatalf("event = %+v", e)
	}
}

func TestRouterSignalPublishesNewModelState(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	_, live := subscribe(t, log)
	Start(t.Context(), log, rt, twoModels, nil)
	next(t, live) // the first scan

	rt.set(router.ModelState{ID: "a", State: router.StateLoading})
	rt.changes <- struct{}{}
	e := next(t, live)
	if got := modelsIn(t, e)[0]["state"]; got != "loading" {
		t.Fatalf("state = %v", got)
	}
}

func TestFailedScanPublishesNothing(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	_, live := subscribe(t, log)
	calls := 0
	var mu sync.Mutex
	list := func() ([]models.Model, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls > 1 {
			return nil, errors.New("folder gone")
		}
		return twoModels()
	}
	Start(t.Context(), log, rt, list, nil)
	next(t, live)

	rt.changes <- struct{}{}
	select {
	case e := <-live:
		t.Fatalf("unexpected event %+v", e)
	case <-time.After(150 * time.Millisecond):
	}
	if e := waitRetained(t, log, "model.state"); len(modelsIn(t, e)) != 3 {
		t.Fatalf("retained = %s", e.Data)
	}
}

func TestCancelStopsPublishing(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	_, live := subscribe(t, log)
	ctx, cancel := context.WithCancel(t.Context())
	Start(ctx, log, rt, twoModels, nil)
	next(t, live)

	cancel()
	rt.changes <- struct{}{}
	select {
	case e := <-live:
		t.Fatalf("event after cancel: %+v", e)
	case <-time.After(100 * time.Millisecond):
	}
}

// stubDownloads has settable items and a channel the test sends signals on.
type stubDownloads struct {
	mu      sync.Mutex
	items   []downloads.Item
	changes chan struct{}
}

func (s *stubDownloads) Items() []downloads.Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items
}
func (s *stubDownloads) set(items ...downloads.Item) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = items
}
func (s *stubDownloads) Subscribe() (<-chan struct{}, func()) { return s.changes, func() {} }

func TestStartPublishesDownloadProgressRetained(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	dl := &stubDownloads{changes: make(chan struct{}, 1), items: []downloads.Item{{ID: "qwen", State: "downloading", Bytes: 5, Total: 10}}}
	Start(t.Context(), log, rt, twoModels, dl)

	e := waitRetained(t, log, "download.progress")
	var d struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(e.Data, &d); err != nil {
		t.Fatal(err)
	}
	if e.Stream != "system" || len(d.Items) != 1 || d.Items[0]["id"] != "qwen" {
		t.Fatalf("event = %s", e.Data)
	}
}

func TestDownloadBurstIsThrottled(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	dl := &stubDownloads{changes: make(chan struct{}, 32)}
	_, live := subscribe(t, log)
	Start(t.Context(), log, rt, twoModels, dl)

	var times []time.Time
	var last event.Event
	collect := func(until time.Duration) {
		deadline := time.After(until)
		for {
			select {
			case e := <-live:
				if e.Type == "download.progress" {
					times = append(times, time.Now())
					last = e
				}
			case <-deadline:
				return
			}
		}
	}
	collect(100 * time.Millisecond) // the first publish at start
	if len(times) != 1 {
		t.Fatalf("%d events at start, want 1", len(times))
	}
	dl.set(downloads.Item{ID: "after-burst", Bytes: 9})
	for i := 0; i < 20; i++ {
		dl.changes <- struct{}{}
	}
	collect(2 * downloadsInterval)

	if len(times) < 2 || len(times) > 3 {
		t.Fatalf("%d download.progress events for a burst, want at most 3 in total", len(times))
	}
	for i := 1; i < len(times); i++ {
		if gap := times[i].Sub(times[i-1]); gap < downloadsInterval-20*time.Millisecond {
			t.Fatalf("events %v apart, want at least %v", gap, downloadsInterval)
		}
	}
	if !strings.Contains(string(last.Data), "after-burst") {
		t.Fatalf("last event = %s, want the items set after the burst", last.Data)
	}
}

func TestNoDownloadsSourcePublishesNoProgress(t *testing.T) {
	log := newLog()
	rt := &stubRouter{changes: make(chan struct{}, 1)}
	_, live := subscribe(t, log)
	Start(t.Context(), log, rt, twoModels, nil)
	next(t, live)
	rt.changes <- struct{}{}
	next(t, live)

	select {
	case e := <-live:
		t.Fatalf("unexpected event %s", e.Type)
	case <-time.After(100 * time.Millisecond):
	}
	retained, _ := subscribe(t, log)
	for _, e := range retained {
		if e.Type == "download.progress" {
			t.Fatal("download.progress was retained")
		}
	}
}
