package llamacpp

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/provider"
)

// fakeInstance records what the router does to a started server.
type fakeInstance struct {
	id     string
	url    string // "" = http://<id>, a server nobody answers on
	events *eventLog
	// measured is what the server reported while it loaded; the zero value reports nothing.
	measured engine.Resources
	asked    *atomic.Int32 // counts Measured calls; nil = not counted
}

// recorder collects what Config.Record is given.
type recorder struct {
	mu  sync.Mutex
	got []Measurement
}

func (r *recorder) record(m Measurement) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, m)
}

func (r *recorder) all() []Measurement {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.got)
}

// waitRecorded waits (with a deadline) until n measurements arrived, and returns them.
func (r *recorder) waitRecorded(t *testing.T, n int) []Measurement {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := r.all(); len(got) >= n {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("recorded %v, want %d measurements", r.all(), n)
	return nil
}

func (f *fakeInstance) Stop(time.Duration) { f.events.add("stop " + f.id) }
func (f *fakeInstance) BaseURL() string {
	if f.url != "" {
		return f.url
	}
	return "http://" + f.id
}
func (f *fakeInstance) State() engine.State   { return engine.StateReady }
func (f *fakeInstance) Wait() <-chan struct{} { return nil }
func (f *fakeInstance) Measured() (engine.Resources, bool) {
	if f.asked != nil {
		f.asked.Add(1)
	}
	return f.measured, f.measured.Known
}

// testStart records the start and runs startFn (nil: succeeds at once).
func testStart(events *eventLog, startFn func(id string) func() error) func(context.Context, engine.Spec) (engine.Instance, error) {
	return func(ctx context.Context, spec engine.Spec) (engine.Instance, error) {
		events.add("start " + spec.Model)
		if startFn != nil {
			if fn := startFn(spec.Model); fn != nil {
				if err := fn(); err != nil {
					return nil, err
				}
			}
		}
		return &fakeInstance{id: spec.Model, events: events}, nil
	}
}

func testPlan(id string, embedding bool) (engine.Spec, error) {
	if id == "missing" {
		return engine.Spec{}, provider.ErrUnknownModel
	}
	return engine.Spec{Model: id, Embedding: embedding}, nil
}

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

func newTestProvider(events *eventLog, startFn func(id string) func() error) *Provider {
	return New(Config{
		Plan:           testPlan,
		Start:          testStart(events, startFn),
		EmbeddingModel: func() string { return "embed" },
		LoadTimeout:    time.Second,
	})
}

// newServerProvider is a provider whose started instances answer on urlFor(id), a test HTTP server.
func newServerProvider(events *eventLog, urlFor func(id string) string) *Provider {
	return New(Config{
		Plan: testPlan,
		Start: func(_ context.Context, spec engine.Spec) (engine.Instance, error) {
			events.add("start " + spec.Model)
			return &fakeInstance{id: spec.Model, url: urlFor(spec.Model), events: events}, nil
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
	r := newTestProvider(ev, nil)

	for range 3 {
		url, release, err := r.Acquire(context.Background(), provider.KindChat, "a")
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
	r := newTestProvider(ev, nil)

	_, releaseA, err := r.Acquire(context.Background(), provider.KindChat, "a")
	if err != nil {
		t.Fatal(err)
	}

	swapped := make(chan error, 1)
	go func() {
		_, release, err := r.Acquire(context.Background(), provider.KindChat, "b")
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
	r := newTestProvider(ev, func(string) func() error {
		return func() error { <-gate; return nil }
	})

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, release, err := r.Acquire(context.Background(), provider.KindChat, "a")
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
	r := newTestProvider(ev, func(string) func() error {
		return func() error { <-gate; return nil }
	})

	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, _, err := r.Acquire(ctx, provider.KindChat, "a")
		first <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	close(gate)
	_, release, err := r.Acquire(context.Background(), provider.KindChat, "a")
	if err != nil {
		t.Fatalf("second request failed: %v", err)
	}
	release()
}

func TestFailedLoadIsRetried(t *testing.T) {
	ev := &eventLog{}
	calls := 0
	r := newTestProvider(ev, func(string) func() error {
		return func() error {
			calls++
			if calls == 1 {
				return errors.New("boom")
			}
			return nil
		}
	})

	_, _, err := r.Acquire(context.Background(), provider.KindChat, "a")
	var le *provider.LoadError
	if !errors.As(err, &le) || !strings.HasPrefix(err.Error(), "load ") {
		t.Fatalf("first load error = %v, want a *provider.LoadError starting with \"load \"", err)
	}
	_, release, err := r.Acquire(context.Background(), provider.KindChat, "a")
	if err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	release()
}

func TestUnknownModelKeepsCurrentRunning(t *testing.T) {
	ev := &eventLog{}
	r := newTestProvider(ev, nil)

	_, release, _ := r.Acquire(context.Background(), provider.KindChat, "a")
	release()
	if _, _, err := r.Acquire(context.Background(), provider.KindChat, "missing"); !errors.Is(err, provider.ErrUnknownModel) {
		t.Fatalf("err = %v, want provider.ErrUnknownModel", err)
	}
	if got := ev.get(); !equal(got, []string{"start a"}) {
		t.Fatalf("events = %v; the running model must not be stopped (and nothing started for missing)", got)
	}
}

func TestStartThatOutlastsLoadTimeoutFailsTheLoad(t *testing.T) {
	r := New(Config{
		Plan: testPlan,
		Start: func(ctx context.Context, _ engine.Spec) (engine.Instance, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
		EmbeddingModel: func() string { return "" },
		LoadTimeout:    50 * time.Millisecond,
	})
	if _, _, err := r.Acquire(context.Background(), provider.KindChat, "a"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want one wrapping context.DeadlineExceeded", err)
	}
	if snap := r.States(); len(snap) != 1 || snap[0].State != provider.StateError {
		t.Fatalf("snapshot = %v, want the model in error", snap)
	}
}

func TestEmbeddingUsesItsOwnSlotAndIgnoresBodyModel(t *testing.T) {
	ev := &eventLog{}
	r := newTestProvider(ev, nil)

	_, rc, _ := r.Acquire(context.Background(), provider.KindChat, "a")
	defer rc()
	url, re, err := r.Acquire(context.Background(), provider.KindEmbedding, "whatever")
	if err != nil || url != "http://embed" {
		t.Fatalf("Acquire = %q, %v", url, err)
	}
	re()
	if got := ev.get(); !equal(got, []string{"start a", "start embed"}) {
		t.Fatalf("events = %v; chat model must stay loaded", got)
	}
}

// recordingProvider starts every model as a fakeInstance reporting measured (started: fails when it returns an error).
func recordingProvider(rec *recorder, asked *atomic.Int32, measured engine.Resources, started error) *Provider {
	return New(Config{
		Plan: testPlan,
		Start: func(_ context.Context, spec engine.Spec) (engine.Instance, error) {
			if started != nil {
				return nil, started
			}
			return &fakeInstance{id: spec.Model, events: &eventLog{}, measured: measured, asked: asked}, nil
		},
		EmbeddingModel: func() string { return "embed" },
		LoadTimeout:    time.Second,
		Record:         rec.record,
	})
}

var measuredMemory = engine.Resources{VRAMBytes: 100, RAMBytes: 50, Known: true, Source: "measured"}

func TestLoadRecordsWhatTheServerMeasured(t *testing.T) {
	rec := &recorder{}
	r := recordingProvider(rec, nil, measuredMemory, nil)
	_, release, err := r.Acquire(context.Background(), provider.KindChat, "a")
	if err != nil {
		t.Fatal(err)
	}
	release()
	got := rec.waitRecorded(t, 1)
	if want := (Measurement{Spec: engine.Spec{Model: "a"}, Memory: measuredMemory}); len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Fatalf("recorded %+v, want %+v", got, want)
	}
}

func TestLoadRecordsNothingWhenNothingWasMeasured(t *testing.T) {
	cases := map[string]struct {
		kind     provider.Kind
		measured engine.Resources
		started  error
	}{
		"nothing measured":  {provider.KindChat, engine.Resources{}, nil},
		"failed load":       {provider.KindChat, measuredMemory, errors.New("boom")},
		"an embedding load": {provider.KindEmbedding, measuredMemory, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			rec, asked := &recorder{}, &atomic.Int32{}
			r := recordingProvider(rec, asked, tc.measured, tc.started)
			_, release, err := r.Acquire(context.Background(), tc.kind, "a")
			if (err != nil) != (tc.started != nil) {
				t.Fatalf("Acquire: %v", err)
			}
			if err == nil {
				release()
				// Measured is asked just before Record would be called.
				deadline := time.Now().Add(2 * time.Second)
				for asked.Load() == 0 && time.Now().Before(deadline) {
					time.Sleep(5 * time.Millisecond)
				}
			}
			if got := rec.all(); len(got) != 0 {
				t.Fatalf("recorded %+v, want nothing", got)
			}
		})
	}
}

func TestLoadWithoutRecordLoadsNormally(t *testing.T) {
	r := New(Config{
		Plan: testPlan,
		Start: func(_ context.Context, spec engine.Spec) (engine.Instance, error) {
			return &fakeInstance{id: spec.Model, events: &eventLog{}, measured: measuredMemory}, nil
		},
		EmbeddingModel: func() string { return "embed" },
		LoadTimeout:    time.Second,
	})
	_, release, err := r.Acquire(context.Background(), provider.KindChat, "a")
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestNoEmbeddingModelChosen(t *testing.T) {
	r := New(Config{EmbeddingModel: func() string { return "" }})
	if _, _, err := r.Acquire(context.Background(), provider.KindEmbedding, ""); !errors.Is(err, provider.ErrNoEmbeddingModel) {
		t.Fatalf("err = %v", err)
	}
}

func TestCloseStopsEverything(t *testing.T) {
	ev := &eventLog{}
	r := newTestProvider(ev, nil)
	_, ra, _ := r.Acquire(context.Background(), provider.KindChat, "a")
	ra()
	_, re, _ := r.Acquire(context.Background(), provider.KindEmbedding, "")
	re()

	r.Close()
	got := ev.get()
	if len(got) != 4 || got[2] == got[3] {
		t.Fatalf("events = %v, want both servers stopped", got)
	}
}

func TestDescribe(t *testing.T) {
	if id := New(Config{}).Describe().ID; id != "provider.llamacpp" {
		t.Fatalf("ID = %q", id)
	}
}

func TestModels(t *testing.T) {
	want := []provider.Model{{ID: "qwen", Kind: provider.ModelChat, Vision: true}, {ID: "embed", Kind: provider.ModelEmbedding}}
	got, err := New(Config{List: func() ([]provider.Model, error) { return want, nil }}).Models(context.Background())
	if err != nil || !slices.Equal(got, want) {
		t.Fatalf("Models = %v, %v; want %v", got, err, want)
	}

	boom := errors.New("no folder")
	if _, err := New(Config{List: func() ([]provider.Model, error) { return nil, boom }}).Models(context.Background()); err != boom {
		t.Fatalf("err = %v, want the List error", err)
	}

	got, err = New(Config{}).Models(context.Background())
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("nil List: Models = %#v, %v; want an empty list", got, err)
	}
}
