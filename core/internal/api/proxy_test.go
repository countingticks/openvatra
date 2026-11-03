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

	"github.com/countingticks/openvatra/core/internal/router"
)

// stubRouter always answers with one backend and records what was asked.
type stubRouter struct {
	baseURL  string
	err      error
	kind     router.Kind
	model    string
	released atomic.Bool
}

func (s *stubRouter) Acquire(_ context.Context, kind router.Kind, model string) (string, func(), error) {
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
	resp := post(t, proxy(rt, router.Chat), body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if rt.kind != router.Chat || rt.model != "qwen" {
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

	resp := post(t, proxy(rt, router.Embedding), `{"input":"hi"}`)
	if resp.StatusCode != 200 || rt.kind != router.Embedding {
		t.Fatalf("status = %d, kind = %v", resp.StatusCode, rt.kind)
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

	resp := post(t, proxy(&stubRouter{baseURL: backend.URL}, router.Chat), `{"model":"m"}`)
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
		kind   router.Kind
		body   string
		err    error
		status int
		code   string
	}{
		{"no model field", router.Chat, `{}`, nil, 400, "bad_request"},
		{"not json", router.Chat, `nope`, nil, 400, "bad_request"},
		{"unknown model", router.Chat, `{"model":"x"}`, router.ErrUnknownModel, 404, "model_not_found"},
		{"no embedding model", router.Embedding, `{}`, router.ErrNoEmbeddingModel, 409, "no_embedding_model"},
		{"load failed", router.Chat, `{"model":"x"}`, io.ErrUnexpectedEOF, 503, "model_load_failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := post(t, proxy(&stubRouter{err: c.err}, c.kind), c.body)
			b, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != c.status || !strings.Contains(string(b), c.code) {
				t.Fatalf("got %d %s, want %d %s", resp.StatusCode, b, c.status, c.code)
			}
		})
	}
}
