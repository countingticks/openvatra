package run

import (
	"reflect"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/profile"
)

const stream = "run:r1"

func queued() event.Payload {
	return event.RunQueued{ChatID: "c1", Profile: "chat", Model: "m1", Origin: "user", RequestID: "q1"}
}
func input(text string) event.Payload {
	return event.InputReceived{ChatID: "c1", Text: text, RequestID: text}
}
func completed() event.Payload {
	return event.MessageCompleted{ChatID: "c1", Parts: []event.MessagePart{{Kind: "text", Text: "a"}}, Model: "m1"}
}
func finished(state string) event.Payload { return event.RunFinished{ChatID: "c1", State: state} }

type unknownType struct{}

func (unknownType) EventType() event.Type {
	return event.Type{Name: "tool.call", V: 1, Class: event.Durable}
}

func TestFoldAndNext(t *testing.T) {
	chat, _ := profile.Builtin().Get("chat")
	started := event.RunStarted{ChatID: "c1"}
	paused := event.RunPaused{ChatID: "c1", Reason: "interrupted"}
	resumed := event.RunResumed{ChatID: "c1"}
	base := State{ID: "r1", ChatID: "c1", Profile: "chat", Model: "m1"}
	with := func(s Status, inbox []string, seq int64) State {
		st := base
		st.Status, st.Inbox, st.LastSeq = s, inbox, seq
		return st
	}

	cases := []struct {
		name   string
		events []event.Payload
		want   State
		action Action
	}{
		{"a queued run with one input asks the model",
			[]event.Payload{queued(), input("hi")}, with(Queued, []string{"hi"}, 2), AskModel},
		{"after its answer it finishes",
			[]event.Payload{queued(), input("hi"), started, completed()}, with(Running, []string{}, 4), Finish},
		{"an input queued mid-answer is asked after the first answer",
			[]event.Payload{queued(), input("one"), started, input("two"), completed()},
			with(Running, []string{"two"}, 5), AskModel},
		{"interrupted, stopped, failed and done runs are idle: interrupted",
			[]event.Payload{queued(), input("hi"), started, paused}, with(Interrupted, []string{"hi"}, 4), Idle},
		{"interrupted, stopped, failed and done runs are idle: stopped",
			[]event.Payload{queued(), input("hi"), started, finished("stopped")},
			with(Stopped, []string{"hi"}, 4), Idle},
		{"interrupted, stopped, failed and done runs are idle: failed",
			[]event.Payload{queued(), input("hi"), started, finished("failed")}, with(Failed, []string{"hi"}, 4), Idle},
		{"interrupted, stopped, failed and done runs are idle: done",
			[]event.Payload{queued(), input("hi"), started, completed(), finished("done")},
			with(Done, []string{}, 5), Idle},
		{"resumed after interrupted asks again for the unanswered input",
			[]event.Payload{queued(), input("hi"), started, paused, resumed}, with(Queued, []string{"hi"}, 5), AskModel},
		{"unknown event types only move LastSeq",
			[]event.Payload{queued(), input("hi"), unknownType{}}, with(Queued, []string{"hi"}, 3), AskModel},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var s State
			for i, p := range tc.events {
				e := event.New(stream, p, time.Unix(0, 0))
				e.Seq = int64(i + 1)
				s = Fold(s, e)
			}
			if len(s.Inbox) == 0 && len(tc.want.Inbox) == 0 {
				s.Inbox, tc.want.Inbox = nil, nil
			}
			if !reflect.DeepEqual(s, tc.want) {
				t.Fatalf("state = %+v, want %+v", s, tc.want)
			}
			if got := Next(s, chat); got != tc.action {
				t.Fatalf("Next = %d, want %d", got, tc.action)
			}
		})
	}
}
