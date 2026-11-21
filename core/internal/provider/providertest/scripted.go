package providertest

import (
	"context"
	"errors"
	"sync"

	"github.com/countingticks/openvatra/core/internal/provider"
)

// Turn is one scripted answer: its deltas, then how it ends.
type Turn struct {
	Reasoning []string       // reasoning deltas, sent first
	Text      []string       // text deltas, sent after
	Usage     provider.Usage // returned in Result.Usage
	Err       error          // returned after the deltas; nil = a normal end
	Hang      bool           // after the deltas, block until ctx is done, then return Stop = StopCancelled
}

// Scripted is a provider.Chat that plays its turns in order, one per Complete call. It is safe for concurrent use.
type Scripted struct {
	mu       sync.Mutex
	turns    []Turn
	requests []provider.Request
	started  chan struct{}
}

// NewScripted returns a chat provider that answers with turns, in order.
func NewScripted(turns ...Turn) *Scripted {
	return &Scripted{turns: turns, started: make(chan struct{}, 64)}
}

var errNoTurn = errors.New("scripted: no turn left")

func (s *Scripted) Complete(ctx context.Context, req provider.Request, emit func(provider.Delta)) (provider.Result, error) {
	s.mu.Lock()
	s.requests = append(s.requests, req)
	if len(s.turns) == 0 {
		s.mu.Unlock()
		return provider.Result{}, errNoTurn
	}
	turn := s.turns[0]
	s.turns = s.turns[1:]
	s.mu.Unlock()
	s.started <- struct{}{}

	var parts []provider.Part
	send := func(kind provider.PartKind, texts []string) bool {
		for _, t := range texts {
			if ctx.Err() != nil {
				return false
			}
			d := provider.Delta{Kind: kind, Text: t}
			parts = provider.AppendDelta(parts, d)
			emit(d)
		}
		return true
	}
	// A cancelled ctx ends the call with the parts so far and no error, as llamacpp.Complete does.
	if !send(provider.PartReasoning, turn.Reasoning) || !send(provider.PartText, turn.Text) {
		return provider.Result{Parts: parts, Stop: provider.StopCancelled}, nil
	}
	if turn.Hang {
		<-ctx.Done()
		return provider.Result{Parts: parts, Stop: provider.StopCancelled}, nil
	}
	if turn.Err != nil {
		return provider.Result{Parts: parts, Usage: turn.Usage}, turn.Err
	}
	return provider.Result{Parts: parts, Usage: turn.Usage, Stop: provider.StopEnd}, nil
}

// Requests returns every request received, in order.
func (s *Scripted) Requests() []provider.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]provider.Request(nil), s.requests...)
}

// Started receives one value per Complete call that took a turn, sent before its first delta.
func (s *Scripted) Started() <-chan struct{} { return s.started }
