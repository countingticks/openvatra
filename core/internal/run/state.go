// Package run advances runs. A run has no stored state of its own: its state is folded from its events, the next
// thing to do is picked from that state, and only the engine's worker has side effects.
package run

import (
	"encoding/json"
	"strings"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/profile"
)

// Status is where a run is, as clients see it.
type Status string

const (
	Queued      Status = "queued"
	Running     Status = "running"
	Interrupted Status = "interrupted"
	Done        Status = "done"
	Stopped     Status = "stopped"
	Failed      Status = "failed"
)

// State is everything the loop needs. It is folded from the run's events and never stored.
type State struct {
	ID, ChatID, Profile, Model string
	Status                     Status
	Inbox                      []string // input texts received and not yet answered, oldest first
	Answers                    int      // message.completed events so far
	LastSeq                    int64

	// WantTitle is never folded: the engine sets it when the run should title its chat after the first answer.
	WantTitle bool
}

// Fold applies one event of the run's stream. It is pure; unknown types only raise LastSeq.
func Fold(s State, e event.Event) State {
	s.LastSeq = max(s.LastSeq, e.Seq)
	switch e.Type {
	case "run.queued":
		var p event.RunQueued
		if json.Unmarshal(e.Data, &p) == nil {
			s.ID, _ = strings.CutPrefix(e.Stream, "run:")
			s.ChatID, s.Profile, s.Model, s.Status = p.ChatID, p.Profile, p.Model, Queued
		}
	case "input.received":
		var p event.InputReceived
		if json.Unmarshal(e.Data, &p) == nil {
			s.Inbox = append(s.Inbox[:len(s.Inbox):len(s.Inbox)], p.Text)
		}
	case "message.completed":
		s.Answers++
		// With Steps: 1, one answer per input: the answer is to the oldest input waiting.
		if len(s.Inbox) > 0 {
			s.Inbox = s.Inbox[1:]
		}
	case "run.started":
		s.Status = Running
	case "run.paused":
		s.Status = Interrupted
	case "run.resumed":
		s.Status = Queued
	case "run.finished":
		var p event.RunFinished
		if json.Unmarshal(e.Data, &p) == nil {
			s.Status = Status(p.State)
		}
	}
	return s
}

// Action is what the worker does next.
type Action int

const (
	Idle     Action = iota // nothing to do: the worker exits
	AskModel               // answer the oldest input in the inbox
	Finish                 // every input is answered: end the run
	Title                  // ask the model for the chat's title, once, after the run's first answer
)

// Next picks the action for s under profile p. It is pure.
func Next(s State, p profile.Profile) Action {
	switch s.Status {
	case Done, Stopped, Failed, Interrupted:
		return Idle
	}
	if p.Title && s.WantTitle && s.Answers > 0 {
		return Title
	}
	if len(s.Inbox) > 0 {
		return AskModel
	}
	return Finish
}
