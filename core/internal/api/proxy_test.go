package api

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/sched"
)

// stubRouter always answers with one backend and records what was asked.
type stubRouter struct {
	baseURL  string
	err      error
	kind     provider.Kind
	model    string
	released atomic.Bool

	snapshot []provider.ModelState
	changes  chan struct{}
	loaded   string
	unloaded string
	unloadOK bool
	notified int
}

func (s *stubRouter) States() []provider.ModelState { return s.snapshot }
func (s *stubRouter) Subscribe() (<-chan struct{}, func()) {
	return s.changes, func() {}
}
func (s *stubRouter) Load(_ context.Context, id string) error { s.loaded = id; return s.err }
func (s *stubRouter) Unload(id string) bool                   { s.unloaded = id; return s.unloadOK }
func (s *stubRouter) Notify()                                 { s.notified++ }

func (s *stubRouter) Acquire(_ context.Context, kind provider.Kind, model string) (string, func(), error) {
	s.kind, s.model = kind, model
	if s.err != nil {
		return "", nil, s.err
	}
	return s.baseURL, func() { s.released.Store(true) }, nil
}

func post(t *testing.T, h http.Handler, body string) *http.Response {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer s3cret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestChatProxyPicksModelFromBodyAndStripsToken(t *testing.T) {
	var gotBody, gotAuth string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody, gotAuth = string(b), r.Header.Get("Authorization")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer backend.Close()
	rt := &stubRouter{baseURL: backend.URL}

	body := `{"model":"qwen","messages":[]}`
	resp := post(t, proxy(rt, provider.KindChat, nil), body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if rt.kind != provider.KindChat || rt.model != "qwen" {
		t.Fatalf("router asked for %v %q", rt.kind, rt.model)
	}
	if gotBody != body {
		t.Fatalf("backend got body %q", gotBody)
	}
	if gotAuth != "" {
		t.Fatalf("token leaked to the model server: %q", gotAuth)
	}
	// The client can see the reply a moment before the handler's deferred release runs.
	deadline := time.Now().Add(2 * time.Second)
	for !rt.released.Load() {
		if time.Now().After(deadline) {
			t.Fatal("slot was not released after the reply")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestEmbeddingsProxyDoesNotNeedModelField(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer backend.Close()
	rt := &stubRouter{baseURL: backend.URL}

	resp := post(t, proxy(rt, provider.KindEmbedding, nil), `{"input":"hi"}`)
	if resp.StatusCode != 200 || rt.kind != provider.KindEmbedding {
		t.Fatalf("status = %d, kind = %v", resp.StatusCode, rt.kind)
	}
}

// waitUntil polls cond for at most 2 s.
func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestChatProxyWaitsWhileARunHoldsTheLease(t *testing.T) {
	var hits atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer backend.Close()
	fifo := sched.NewFIFO(nil)
	held, err := fifo.Acquire(context.Background(), sched.Request{RunID: "run1", Model: "m"})
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan *http.Response, 1)
	h := proxy(&stubRouter{baseURL: backend.URL}, provider.KindChat, fifo)
	go func() { done <- post(t, h, `{"model":"m"}`) }()
	waitUntil(t, "the request waits for the lease", func() bool {
		w := fifo.State().Waiting
		return len(w) == 1 && w[0].RunID == "openai"
	})
	if hits.Load() != 0 {
		t.Fatal("the request reached the model server while a run held the lease")
	}

	held.Release()
	select {
	case resp := <-done:
		if resp.StatusCode != 200 || hits.Load() != 1 {
			t.Fatalf("status = %d, hits = %d", resp.StatusCode, hits.Load())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the request did not go through once the lease was released")
	}
	waitUntil(t, "the lease is released after the reply", func() bool { return fifo.State().Holder == "" })
}

func TestEmbeddingsNeverWaitForTheLease(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer backend.Close()
	fifo := sched.NewFIFO(nil)
	held, err := fifo.Acquire(context.Background(), sched.Request{RunID: "run1", Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()

	resp := post(t, proxy(&stubRouter{baseURL: backend.URL}, provider.KindEmbedding, fifo), `{"input":"hi"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if w := fifo.State().Waiting; len(w) != 0 {
		t.Errorf("waiting = %+v, want none", w)
	}
}

func TestChatProxyStreamsChunksAsTheyArrive(t *testing.T) {
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: one\n\n")
		w.(http.Flusher).Flush()
		<-release // the second chunk only exists after the client has seen the first
		_, _ = io.WriteString(w, "data: two\n\n")
	}))
	defer backend.Close()

	resp := post(t, proxy(&stubRouter{baseURL: backend.URL}, provider.KindChat, nil), `{"model":"m"}`)
	r := bufio.NewReader(resp.Body)

	first := make(chan string, 1)
	go func() { line, _ := r.ReadString('\n'); first <- line }()
	select {
	case line := <-first:
		if line != "data: one\n" {
			t.Fatalf("first line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first chunk was held back: the proxy is buffering the stream")
	}
	close(release)
	rest, _ := io.ReadAll(r)
	if !strings.Contains(string(rest), "data: two") {
		t.Fatalf("rest = %q", rest)
	}
}

func TestProxyErrors(t *testing.T) {
	cases := []struct {
		name   string
		kind   provider.Kind
		body   string
		err    error
		status int
		code   string
	}{
		{"no model field", provider.KindChat, `{}`, nil, 400, "bad_request"},
		{"not json", provider.KindChat, `nope`, nil, 400, "bad_request"},
		{"unknown model", provider.KindChat, `{"model":"x"}`, provider.ErrUnknownModel, 404, "model_not_found"},
		{"no embedding model", provider.KindEmbedding, `{}`, provider.ErrNoEmbeddingModel, 409, "no_embedding_model"},
		{"load failed", provider.KindChat, `{"model":"x"}`, io.ErrUnexpectedEOF, 503, "model_load_failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := post(t, proxy(&stubRouter{err: c.err}, c.kind, nil), c.body)
			b, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != c.status || !strings.Contains(string(b), c.code) {
				t.Fatalf("got %d %s, want %d %s", resp.StatusCode, b, c.status, c.code)
			}
		})
	}
}
