// Package providertest is the contract every provider.Provider must pass.
package providertest

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/provider"
)

type Fixture struct {
	// New returns a provider whose server plays script for every chat request.
	New     func(t *testing.T, script Script) provider.Provider
	Loaded  string // a model the provider can answer with
	Unknown string // an id the provider does not have
}

type Script struct {
	Text        []string           // text deltas, sent in order
	Usage       bool               // the server reports usage (exact counts 11 and 7)
	ToolCall    *provider.ToolCall // sent after the text, in fragments where the dialect allows
	Hang        bool               // after the text, the server keeps the stream open until the request ends
	CountTokens int                // what the server's tokenizer answers
	// Ended is set by Run together with Hang; the server calls it once the hanging request's context has ended.
	Ended func()
}

var idPattern = regexp.MustCompile(`^[a-z]+(\.[a-z0-9]+)+$`)

// Run is one subtest per contract rule; a rule needing a capability the provider lacks is skipped.
func Run(t *testing.T, f Fixture) {
	t.Run("describe", func(t *testing.T) {
		if id := f.New(t, Script{}).Describe().ID; !idPattern.MatchString(id) {
			t.Fatalf("id %q is not lowercase and dot-separated", id)
		}
	})

	t.Run("deltas", func(t *testing.T) {
		script := Script{Text: []string{"Hel", "lo", " world"}}
		var deltas []provider.Delta
		res, err := chat(t, f.New(t, script)).Complete(context.Background(), f.request(f.Loaded), func(d provider.Delta) {
			deltas = append(deltas, d)
		})
		if err != nil {
			t.Fatal(err)
		}
		var folded []provider.Part
		for _, d := range deltas {
			folded = provider.AppendDelta(folded, d)
		}
		if !reflect.DeepEqual(folded, res.Parts) {
			t.Fatalf("deltas fold to %+v, Result.Parts is %+v", folded, res.Parts)
		}
		if got, want := text(res.Parts), strings.Join(script.Text, ""); got != want {
			t.Fatalf("text = %q, want %q", got, want)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		ended := make(chan struct{})
		script := Script{Text: []string{"half"}, Hang: true, Ended: func() { close(ended) }}
		p := chat(t, f.New(t, script))
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		type outcome struct {
			res provider.Result
			err error
		}
		done := make(chan outcome, 1)
		go func() {
			res, err := p.Complete(ctx, f.request(f.Loaded), func(provider.Delta) { cancel() })
			done <- outcome{res, err}
		}()
		select {
		case o := <-done:
			if o.err != nil || o.res.Stop != provider.StopCancelled {
				t.Fatalf("Complete = %+v, %v; want StopCancelled and no error", o.res, o.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Complete did not return within 2 s of the cancel")
		}
		select {
		case <-ended:
		case <-time.After(2 * time.Second):
			t.Fatal("the server never saw its request end")
		}
	})

	t.Run("toolcall", func(t *testing.T) {
		call := &provider.ToolCall{ID: "call_1", Name: "search", Arguments: json.RawMessage(`{"q":"cats","n":3}`)}
		res, err := chat(t, f.New(t, Script{Text: []string{"Let me look."}, ToolCall: call})).
			Complete(context.Background(), f.request(f.Loaded), func(provider.Delta) {})
		if err != nil {
			t.Fatal(err)
		}
		var calls []*provider.ToolCall
		for _, p := range res.Parts {
			if p.Kind == provider.PartToolCall {
				calls = append(calls, p.Call)
			}
		}
		if len(calls) != 1 {
			t.Fatalf("parts = %+v, want exactly one tool call", res.Parts)
		}
		got := calls[0]
		if got.ID != call.ID || got.Name != call.Name || !sameJSON(got.Arguments, call.Arguments) {
			t.Fatalf("call = %+v (arguments %s), want %+v", got, got.Arguments, call)
		}
		if res.Stop != provider.StopToolCalls {
			t.Fatalf("stop = %v, want StopToolCalls", res.Stop)
		}
	})

	t.Run("usage", func(t *testing.T) {
		for _, reported := range []bool{true, false} {
			res, err := chat(t, f.New(t, Script{Text: []string{"a"}, Usage: reported})).
				Complete(context.Background(), f.request(f.Loaded), func(provider.Delta) {})
			if err != nil {
				t.Fatal(err)
			}
			u := res.Usage
			if reported && (!u.Exact || u.PromptTokens != 11 || u.AnswerTokens != 7) {
				t.Fatalf("usage = %+v, want exact 11/7", u)
			}
			if !reported && u.Exact {
				t.Fatalf("usage = %+v, want Exact false when the server sent none", u)
			}
		}
	})

	t.Run("count", func(t *testing.T) {
		c, ok := f.New(t, Script{CountTokens: 4}).(provider.Counter)
		if !ok {
			t.Skip("provider.Counter")
		}
		if n, err := c.Count(context.Background(), f.Loaded, "one two three four"); err != nil || n != 4 {
			t.Fatalf("Count = %d, %v; want 4", n, err)
		}
	})

	t.Run("unknown", func(t *testing.T) {
		p := f.New(t, Script{Text: []string{"a"}})
		c := chat(t, p)
		if _, err := c.Complete(context.Background(), f.request(f.Loaded), func(provider.Delta) {}); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Complete(context.Background(), f.request(f.Unknown), func(provider.Delta) {}); !errors.Is(err, provider.ErrUnknownModel) {
			t.Fatalf("err = %v, want provider.ErrUnknownModel", err)
		}
		r, ok := p.(provider.Resident)
		if !ok {
			return
		}
		for _, st := range r.States() {
			if st.ID == f.Loaded && st.State == provider.StateReady {
				return
			}
		}
		t.Fatalf("states = %+v, want %s still ready", r.States(), f.Loaded)
	})
}

func (f Fixture) request(model string) provider.Request {
	return provider.Request{Model: model, Messages: []provider.Message{provider.TextMessage("user", "hi")}}
}

// chat returns p as a provider.Chat, or skips the subtest.
func chat(t *testing.T, p provider.Provider) provider.Chat {
	t.Helper()
	c, ok := p.(provider.Chat)
	if !ok {
		t.Skip("provider.Chat")
	}
	return c
}

func text(parts []provider.Part) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Kind == provider.PartText {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func sameJSON(a, b json.RawMessage) bool {
	var u, v any
	if json.Unmarshal(a, &u) != nil || json.Unmarshal(b, &v) != nil {
		return false
	}
	return reflect.DeepEqual(u, v)
}
