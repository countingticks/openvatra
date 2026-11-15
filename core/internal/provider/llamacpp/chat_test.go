package llamacpp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/countingticks/openvatra/core/internal/provider"
)

// upstream is a fake llama-server: a scripted /v1/chat/completions.
type upstream struct {
	mu       sync.Mutex
	requests []string                                            // completion request bodies, in order
	handler  func(n int, w http.ResponseWriter, r *http.Request) // n = 0 for the first completion request
}

func (u *upstream) start(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		n := len(u.requests)
		u.requests = append(u.requests, string(body))
		u.mu.Unlock()
		u.handler(n, w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func (u *upstream) bodies() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return slices.Clone(u.requests)
}

func sse(w http.ResponseWriter, lines ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, l := range lines {
		fmt.Fprintf(w, "data: %s\n\n", l)
	}
	w.(http.Flusher).Flush()
}

// completeWith runs one Complete for model "qwen" against up and collects the deltas.
func completeWith(t *testing.T, up *upstream, req provider.Request) ([]provider.Delta, provider.Result, error) {
	t.Helper()
	url := up.start(t)
	p := newServerProvider(&eventLog{}, func(string) string { return url })
	if req.Model == "" {
		req.Model = "qwen"
	}
	var deltas []provider.Delta
	res, err := p.Complete(context.Background(), req, func(d provider.Delta) { deltas = append(deltas, d) })
	return deltas, res, err
}

func hello() provider.Request {
	return provider.Request{Messages: []provider.Message{provider.TextMessage("user", "hi")}}
}

func textOf(parts []provider.Part) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Kind == provider.PartText {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func TestCompleteStreamsReasoningThenText(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w,
			`{"choices":[{"delta":{"reasoning_content":"hmm "}}]}`,
			`{"choices":[{"delta":{"reasoning_content":"ok"}}]}`,
			`{"choices":[{"delta":{"content":"Hel"}}]}`,
			`{"choices":[{"delta":{"content":"lo"}}]}`,
			`{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7},"timings":{"predicted_per_second":42.5}}`,
			`[DONE]`)
	}}
	deltas, res, err := completeWith(t, up, hello())
	if err != nil {
		t.Fatal(err)
	}
	wantDeltas := []provider.Delta{
		{Kind: provider.PartReasoning, Text: "hmm "}, {Kind: provider.PartReasoning, Text: "ok"},
		{Kind: provider.PartText, Text: "Hel"}, {Kind: provider.PartText, Text: "lo"},
	}
	if !slices.Equal(deltas, wantDeltas) {
		t.Fatalf("deltas = %+v", deltas)
	}
	wantParts := []provider.Part{{Kind: provider.PartReasoning, Text: "hmm ok"}, {Kind: provider.PartText, Text: "Hello"}}
	if !slices.Equal(res.Parts, wantParts) {
		t.Fatalf("parts = %+v", res.Parts)
	}
	u := res.Usage
	if !u.Exact || u.PromptTokens != 20 || u.AnswerTokens != 7 || u.TokensPerSecond != 42.5 || res.Stop != provider.StopEnd {
		t.Fatalf("result = %+v", res)
	}
}

func TestCompleteWithoutUsageIsNotExact(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"a"}}]}`, `[DONE]`)
	}}
	_, res, err := completeWith(t, up, hello())
	if err != nil || res.Usage.Exact || res.Usage.PromptTokens != 0 || res.Usage.AnswerTokens != 0 {
		t.Fatalf("result = %+v, %v", res, err)
	}
}

func requestKeys(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("request body %q: %v", body, err)
	}
	return m
}

func TestCompletePlainRequestBody(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) { sse(w, `[DONE]`) }}
	if _, _, err := completeWith(t, up, hello()); err != nil {
		t.Fatal(err)
	}
	m := requestKeys(t, up.bodies()[0])
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, []string{"messages", "model", "stream", "stream_options"}) {
		t.Fatalf("keys = %v", keys)
	}
	if string(m["model"]) != `"qwen"` || string(m["messages"]) != `[{"role":"user","content":"hi"}]` ||
		string(m["stream"]) != "true" || string(m["stream_options"]) != `{"include_usage":true}` {
		t.Fatalf("body = %s", up.bodies()[0])
	}
}

func TestCompleteSendsMaxOutAndTemperature(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) { sse(w, `[DONE]`) }}
	temp := 0.25
	req := hello()
	req.MaxOut, req.Sampling.Temperature = 128, &temp
	if _, _, err := completeWith(t, up, req); err != nil {
		t.Fatal(err)
	}
	m := requestKeys(t, up.bodies()[0])
	if string(m["max_tokens"]) != "128" || string(m["temperature"]) != "0.25" {
		t.Fatalf("body = %s", up.bodies()[0])
	}
	if _, ok := m["top_p"]; ok {
		t.Fatalf("top_p sent though unset: %s", up.bodies()[0])
	}
}

func TestCompleteLeavesReasoningOutOfHistory(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) { sse(w, `[DONE]`) }}
	req := provider.Request{Messages: []provider.Message{
		provider.TextMessage("user", "one"),
		{Role: "assistant", Parts: []provider.Part{{Kind: provider.PartReasoning, Text: "SECRET"}, {Kind: provider.PartText, Text: "a"}}},
		provider.TextMessage("user", "two"),
	}}
	if _, _, err := completeWith(t, up, req); err != nil {
		t.Fatal(err)
	}
	if b := up.bodies()[0]; strings.Contains(b, "SECRET") || !strings.Contains(b, `{"role":"assistant","content":"a"}`) {
		t.Fatalf("body = %s", b)
	}
}

func TestCompleteImagePartFailsBeforeSending(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) { sse(w, `[DONE]`) }}
	req := provider.Request{Messages: []provider.Message{
		provider.TextMessage("system", "s"),
		{Role: "user", Parts: []provider.Part{{Kind: provider.PartText, Text: "look"}, {Kind: provider.PartImage, Ref: "a.png"}}},
	}}
	_, _, err := completeWith(t, up, req)
	if err == nil || err.Error() != "unsupported part kind 2 in message 1" {
		t.Fatalf("err = %v", err)
	}
	if n := len(up.bodies()); n != 0 {
		t.Fatalf("%d requests reached the server", n)
	}
}

func TestCompleteNon200(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		want   func(error) bool
	}{
		{"context exceeded", http.StatusBadRequest, `{"error":{"type":"exceed_context_size_error","message":"too long"}}`,
			func(err error) bool { return errors.Is(err, provider.ErrContextExceeded) }},
		{"server error", http.StatusInternalServerError, `oops`,
			func(err error) bool { return err != nil && err.Error() == "model server answered 500" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				fmt.Fprint(w, tt.body)
			}}
			if _, _, err := completeWith(t, up, hello()); !tt.want(err) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestCompleteErrorChunkKeepsTextSoFar(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"par"}}]}`, `{"error":{"message":"boom","type":"server_error"}}`)
	}}
	_, res, err := completeWith(t, up, hello())
	if err == nil || err.Error() != "model error: boom" || textOf(res.Parts) != "par" {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestCompleteAssemblesToolCallFragments(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w,
			`{"choices":[{"delta":{"content":"Let me look."}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"q\":"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"cats\"}"}}]},"finish_reason":"tool_calls"}]}`,
			`[DONE]`)
	}}
	_, res, err := completeWith(t, up, hello())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Parts) != 2 || res.Parts[1].Kind != provider.PartToolCall {
		t.Fatalf("parts = %+v", res.Parts)
	}
	c := res.Parts[1].Call
	if c.ID != "call_1" || c.Name != "search" || string(c.Arguments) != `{"q":"cats"}` || res.Stop != provider.StopToolCalls {
		t.Fatalf("call = %+v, stop = %v", c, res.Stop)
	}
}

func TestCompleteFinishLengthIsStopLength(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}`, `[DONE]`)
	}}
	if _, res, err := completeWith(t, up, hello()); err != nil || res.Stop != provider.StopLength {
		t.Fatalf("result = %+v, %v", res, err)
	}
}

func TestCompleteCancelKeepsPartialText(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, r *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"half"}}]}`)
		<-r.Context().Done() // the model keeps "thinking" until we hang up
	}}
	url := up.start(t)
	p := newServerProvider(&eventLog{}, func(string) string { return url })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, err := p.Complete(ctx, provider.Request{Model: "qwen", Messages: hello().Messages}, func(provider.Delta) { cancel() })
	if err != nil || res.Stop != provider.StopCancelled || textOf(res.Parts) != "half" {
		t.Fatalf("result = %+v, %v", res, err)
	}
}

func TestCompleteStreamCutBeforeDone(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		sse(w, `{"choices":[{"delta":{"content":"par"}}]}`)
	}}
	_, res, err := completeWith(t, up, hello())
	if err == nil || err.Error() != "stream ended early" || textOf(res.Parts) != "par" {
		t.Fatalf("result = %+v, %v", res, err)
	}
}

func TestCompleteUnknownModelSendsNothing(t *testing.T) {
	up := &upstream{handler: func(_ int, w http.ResponseWriter, _ *http.Request) { sse(w, `[DONE]`) }}
	req := hello()
	req.Model = "missing"
	if _, _, err := completeWith(t, up, req); !errors.Is(err, provider.ErrUnknownModel) {
		t.Fatalf("err = %v", err)
	}
	if n := len(up.bodies()); n != 0 {
		t.Fatalf("%d requests reached the server", n)
	}
}
