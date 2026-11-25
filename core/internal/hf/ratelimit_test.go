package hf

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"
)

// limitStart is a whole second, so an HTTP date (which has no fractions) can say "40 s from now" exactly.
var limitStart = time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)

// searchOnce runs one search for q.
func searchOnce(c *Client, q string) error {
	_, err := c.Search(context.Background(), q, 0)
	return err
}

// searchN runs n searches for distinct queries, so none is answered from the cache.
func searchN(t *testing.T, c *Client, prefix string, n int) {
	t.Helper()
	for i := range n {
		if err := searchOnce(c, fmt.Sprintf("%s%02d", prefix, i)); err != nil {
			t.Fatalf("search %d: %v", i+1, err)
		}
	}
}

// hold makes the bucket's waits record only, so the clock stays where the test put it.
func hold(c *Client) *[]time.Duration {
	waits := &[]time.Duration{}
	c.limit.sleep = func(_ context.Context, d time.Duration) error {
		*waits = append(*waits, d)
		return nil
	}
	return waits
}

// waitFor polls cond until it holds or a second passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within a second")
		}
		time.Sleep(time.Millisecond)
	}
}

func rateLimitedWait(t *testing.T, err error) time.Duration {
	t.Helper()
	var rl *RateLimitedError
	if !errors.As(err, &rl) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want a RateLimitedError", err)
	}
	return rl.Wait
}

func TestRateLimitBurstOfFiveThenAWait(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	c, waits := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})
	searchN(t, c, "q", 5)
	if len(*waits) != 0 {
		t.Fatalf("five searches waited %v", *waits)
	}
	if err := searchOnce(c, "sixth"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(*waits, []time.Duration{time.Second}) {
		t.Fatalf("waits = %v, want [1s]", *waits)
	}
}

func TestRateLimitWaitersQueueThenFail(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	c, _ := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})
	waits := hold(c)
	searchN(t, c, "q", 7)
	if !slices.Equal(*waits, []time.Duration{time.Second, 2 * time.Second}) {
		t.Fatalf("waits = %v, want [1s 2s]", *waits)
	}
	if wait := rateLimitedWait(t, searchOnce(c, "eighth")); wait != 3*time.Second {
		t.Fatalf("wait = %v, want 3s", wait)
	}
	if n := len(f.requests()); n != 7 {
		t.Fatalf("%d requests, want 7", n)
	}
}

func TestRateLimitRefills(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	clock := &fakeClock{t: limitStart}
	c, _ := f.limitedClient(t, Config{}, clock)
	waits := hold(c)
	searchN(t, c, "a", 5)
	clock.t = clock.t.Add(3 * time.Second)
	searchN(t, c, "b", 3)
	if len(*waits) != 0 {
		t.Fatalf("three calls after 3 s waited %v", *waits)
	}
	if err := searchOnce(c, "b-fourth"); err != nil || len(*waits) != 1 {
		t.Fatalf("the fourth call: %v, waits %v; want one wait", err, *waits)
	}

	clock.t = clock.t.Add(time.Hour)
	*waits = nil
	searchN(t, c, "c", 5)
	if len(*waits) != 0 {
		t.Fatalf("five calls after an hour waited %v", *waits)
	}
	if err := searchOnce(c, "c-sixth"); err != nil || !slices.Equal(*waits, []time.Duration{time.Second}) {
		t.Fatalf("the sixth call after an hour: %v, waits %v; want [1s] (capped at 5)", err, *waits)
	}
}

func TestRateLimitFilesTakesATokenPerRequest(t *testing.T) {
	routes := fakeRepo(gguf("m-Q4_0.gguf", 10))
	routes["/api/models"] = serveBody("[]")
	f := newFakeHF(t, routes)
	c, waits := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})
	searchN(t, c, "q", 4)
	if _, err := c.Files(context.Background(), "o", "m"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(*waits, []time.Duration{time.Second}) {
		t.Fatalf("waits = %v, want [1s] on the tree request", *waits)
	}
	if n := len(f.requests()); n != 6 {
		t.Fatalf("%d requests, want 6", n)
	}
}

func TestRateLimitCheckTakesAToken(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{
		"/api/models": serveBody("[]"),
		checkPath:     servePartial(ggufBytes(49, 1, allBlocks(49)...)),
	})
	c, _ := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})
	hold(c)
	searchN(t, c, "q", 7)
	_, err := c.Check(context.Background(), "o/m", testSHA, checkFileRef)
	rateLimitedWait(t, err)
	for _, r := range f.requests() {
		if r.URL.Path == checkPath {
			t.Fatal("the resolve URL was asked")
		}
	}
}

func TestRateLimitHuggingFace429WaitsOutRetryAfter(t *testing.T) {
	first := true
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": func(w http.ResponseWriter, r *http.Request) {
		if first {
			first = false
			w.Header().Set("Retry-After", "12")
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte("[]"))
	}})
	clock := &fakeClock{t: limitStart}
	c, _ := f.limitedClient(t, Config{}, clock)

	err := searchOnce(c, "first")
	if !errors.Is(err, ErrRateLimited) || err.Error() != "Hugging Face is busy. Try again in 12 seconds." {
		t.Fatalf("err = %v", err)
	}
	clock.t = clock.t.Add(5 * time.Second)
	err = searchOnce(c, "second")
	if wait := rateLimitedWait(t, err); wait != 7*time.Second || err.Error() != "Hugging Face is busy. Try again in 7 seconds." {
		t.Fatalf("5 s later: %v", err)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("%d requests while blocked, want 1", n)
	}
	clock.t = clock.t.Add(7 * time.Second)
	if err := searchOnce(c, "third"); err != nil {
		t.Fatalf("12 s after the 429: %v", err)
	}
	if n := len(f.requests()); n != 2 {
		t.Fatalf("%d requests, want 2", n)
	}
}

func TestRateLimitRetryAfterValues(t *testing.T) {
	cases := []struct {
		name, header string
		want         time.Duration
	}{
		{"missing", "", 30 * time.Second},
		{"unreadable", "soon", 30 * time.Second},
		{"a date in the past", limitStart.Add(-time.Minute).Format(http.TimeFormat), 30 * time.Second},
		{"a date 40 s ahead", limitStart.Add(40 * time.Second).Format(http.TimeFormat), 40 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": func(w http.ResponseWriter, r *http.Request) {
				if tc.header != "" {
					w.Header().Set("Retry-After", tc.header)
				}
				http.Error(w, "slow down", http.StatusTooManyRequests)
			}})
			c, _ := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})
			if wait := rateLimitedWait(t, searchOnce(c, "qwen")); wait != tc.want {
				t.Fatalf("wait = %v, want %v", wait, tc.want)
			}
		})
	}
}

// Two requests in flight at once both get a 429: the search's 60 s arrives first, then the files' 10 s.
func TestRateLimitShorterSecond429KeepsTheLaterBlock(t *testing.T) {
	releaseLong, releaseShort := make(chan struct{}), make(chan struct{})
	busy := func(release chan struct{}, retry string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			<-release
			w.Header().Set("Retry-After", retry)
			http.Error(w, "slow down", http.StatusTooManyRequests)
		}
	}
	f := newFakeHF(t, map[string]http.HandlerFunc{
		"/api/models":     busy(releaseLong, "60"),
		"/api/models/o/m": busy(releaseShort, "10"),
	})
	c, _ := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})

	long, short := make(chan error, 1), make(chan error, 1)
	go func() { long <- searchOnce(c, "qwen") }()
	go func() { _, err := c.Files(context.Background(), "o", "m"); short <- err }()
	waitFor(t, func() bool { return len(f.requests()) == 2 })
	close(releaseLong)
	rateLimitedWait(t, <-long)
	close(releaseShort)
	rateLimitedWait(t, <-short)

	if wait := rateLimitedWait(t, searchOnce(c, "third")); wait != 60*time.Second {
		t.Fatalf("wait = %v, want 60s", wait)
	}
}

func TestRateLimitCancelledWaitSendsNothing(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{"/api/models": serveBody("[]")})
	c, _ := f.limitedClient(t, Config{}, &fakeClock{t: limitStart})
	c.limit.sleep = nil // the real timer
	searchN(t, c, "q", 5)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Search(ctx, "sixth", 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if n := len(f.requests()); n != 5 {
		t.Fatalf("%d requests, want 5", n)
	}
}

func TestRateLimitedErrorRoundsUp(t *testing.T) {
	cases := []struct {
		wait time.Duration
		want string
	}{
		{1200 * time.Millisecond, "Hugging Face is busy. Try again in 2 seconds."},
		{300 * time.Millisecond, "Hugging Face is busy. Try again in 1 second."},
	}
	for _, tc := range cases {
		if got := (&RateLimitedError{Wait: tc.wait}).Error(); got != tc.want {
			t.Errorf("Wait %v: %q, want %q", tc.wait, got, tc.want)
		}
	}
}
