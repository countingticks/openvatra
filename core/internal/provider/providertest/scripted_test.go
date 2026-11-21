package providertest

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/provider"
)

func TestScripted(t *testing.T) {
	t.Run("turns are played in order and Requests records each request", func(t *testing.T) {
		usage := provider.Usage{PromptTokens: 5, AnswerTokens: 2, Exact: true}
		s := NewScripted(
			Turn{Reasoning: []string{"hm", "m"}, Text: []string{"Hel", "lo"}, Usage: usage},
			Turn{Text: []string{"second"}},
		)
		var deltas []provider.Delta
		res, err := s.Complete(context.Background(), provider.Request{Model: "a"}, func(d provider.Delta) {
			deltas = append(deltas, d)
		})
		if err != nil {
			t.Fatal(err)
		}
		wantParts := []provider.Part{{Kind: provider.PartReasoning, Text: "hmm"}, {Kind: provider.PartText, Text: "Hello"}}
		if !reflect.DeepEqual(res.Parts, wantParts) || res.Usage != usage || res.Stop != provider.StopEnd {
			t.Fatalf("first result = %+v", res)
		}
		if len(deltas) != 4 || deltas[0].Kind != provider.PartReasoning || deltas[3] != (provider.Delta{Kind: provider.PartText, Text: "lo"}) {
			t.Fatalf("deltas = %+v", deltas)
		}
		res, err = s.Complete(context.Background(), provider.Request{Model: "b"}, func(provider.Delta) {})
		if err != nil || len(res.Parts) != 1 || res.Parts[0].Text != "second" {
			t.Fatalf("second result = %+v, %v", res, err)
		}
		reqs := s.Requests()
		if len(reqs) != 2 || reqs[0].Model != "a" || reqs[1].Model != "b" {
			t.Fatalf("requests = %+v", reqs)
		}
		if len(s.Started()) != 2 {
			t.Fatalf("started %d times, want 2", len(s.Started()))
		}
	})

	t.Run("a hanging turn returns its partial parts as cancelled when ctx ends", func(t *testing.T) {
		s := NewScripted(Turn{Text: []string{"part"}, Hang: true})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan provider.Result, 1)
		emitted := make(chan struct{}, 1)
		go func() {
			res, err := s.Complete(ctx, provider.Request{}, func(provider.Delta) { emitted <- struct{}{} })
			if err != nil {
				t.Error(err)
			}
			done <- res
		}()
		<-emitted
		cancel()
		select {
		case res := <-done:
			if res.Stop != provider.StopCancelled || len(res.Parts) != 1 || res.Parts[0].Text != "part" {
				t.Fatalf("result = %+v", res)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Complete did not return after ctx ended")
		}
	})

	t.Run("no turn left is an error", func(t *testing.T) {
		_, err := NewScripted().Complete(context.Background(), provider.Request{}, func(provider.Delta) {})
		if err == nil || err.Error() != "scripted: no turn left" {
			t.Fatalf("err = %v", err)
		}
	})
}
