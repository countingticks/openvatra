package sched

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

type acquired struct {
	lease Lease
	err   error
}

// acquire starts Acquire in a goroutine; its result arrives on the returned channel.
func acquire(f *FIFO, ctx context.Context, runID, why string) <-chan acquired {
	out := make(chan acquired, 1)
	go func() {
		l, err := f.Acquire(ctx, Request{RunID: runID, Model: "m", Class: Interactive, Why: why})
		out <- acquired{l, err}
	}()
	return out
}

func got(t *testing.T, ch <-chan acquired) acquired {
	t.Helper()
	select {
	case a := <-ch:
		return a
	case <-time.After(5 * time.Second):
		t.Fatal("Acquire did not return")
		return acquired{}
	}
}

func notYet(t *testing.T, ch <-chan acquired) {
	t.Helper()
	select {
	case a := <-ch:
		t.Fatalf("Acquire returned early: %+v", a)
	default:
	}
}

// waitState polls State until ok holds, for at most 5 s.
func waitState(t *testing.T, f *FIFO, ok func(State) bool) State {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := f.State()
		if ok(s) {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatalf("state never matched; last %+v", s)
		}
		time.Sleep(time.Millisecond)
	}
}

func waiting(n int) func(State) bool { return func(s State) bool { return len(s.Waiting) == n } }

func TestFIFO(t *testing.T) {
	ctx := context.Background()

	t.Run("the second Acquire waits until the first lease is released", func(t *testing.T) {
		f := NewFIFO(nil)
		first := got(t, acquire(f, ctx, "a", ""))
		if first.err != nil || first.lease.Slot() != 0 {
			t.Fatalf("first = %+v", first)
		}
		second := acquire(f, ctx, "b", "")
		waitState(t, f, waiting(1))
		notYet(t, second)
		first.lease.Release()
		if b := got(t, second); b.err != nil || f.State().Holder != "b" {
			t.Fatalf("second = %+v, state %+v", b, f.State())
		}
	})

	t.Run("three waiters are granted in arrival order", func(t *testing.T) {
		f := NewFIFO(nil)
		holder := got(t, acquire(f, ctx, "h", ""))
		var chans []<-chan acquired
		for i, id := range []string{"a", "b", "c"} {
			chans = append(chans, acquire(f, ctx, id, ""))
			waitState(t, f, waiting(i+1))
		}
		lease := holder.lease
		for i, id := range []string{"a", "b", "c"} {
			lease.Release()
			a := got(t, chans[i])
			if a.err != nil || f.State().Holder != id {
				t.Fatalf("grant %d: %+v, state %+v", i, a, f.State())
			}
			lease = a.lease
		}
		lease.Release()
		if s := f.State(); s.Holder != "" || len(s.Waiting) != 0 {
			t.Fatalf("state after the last release = %+v", s)
		}
	})

	t.Run("a cancelled waiter leaves the queue and the next one is granted", func(t *testing.T) {
		f := NewFIFO(nil)
		holder := got(t, acquire(f, ctx, "h", ""))
		cctx, cancel := context.WithCancel(ctx)
		a := acquire(f, cctx, "a", "")
		waitState(t, f, waiting(1))
		b := acquire(f, ctx, "b", "")
		waitState(t, f, waiting(2))
		c := acquire(f, ctx, "c", "")
		waitState(t, f, waiting(3))
		cancel()
		if r := got(t, a); !errors.Is(r.err, context.Canceled) || r.lease != nil {
			t.Fatalf("cancelled waiter = %+v", r)
		}
		s := waitState(t, f, waiting(2))
		if s.Waiting[0].RunID != "b" || s.Waiting[1].RunID != "c" {
			t.Fatalf("order after leave = %+v", s.Waiting)
		}
		holder.lease.Release()
		if r := got(t, b); r.err != nil {
			t.Fatal(r.err)
		}
		notYet(t, c)
	})

	t.Run("releasing twice grants only once", func(t *testing.T) {
		f := NewFIFO(nil)
		holder := got(t, acquire(f, ctx, "h", ""))
		a := acquire(f, ctx, "a", "")
		waitState(t, f, waiting(1))
		b := acquire(f, ctx, "b", "")
		waitState(t, f, waiting(2))
		holder.lease.Release()
		got(t, a)
		holder.lease.Release()
		if s := f.State(); s.Holder != "a" || len(s.Waiting) != 1 {
			t.Fatalf("state after a second release = %+v", s)
		}
		notYet(t, b)
	})

	t.Run("State and onChange name the holder and why each waiter waits", func(t *testing.T) {
		changes := make(chan State, 16)
		f := NewFIFO(func(s State) { changes <- s })
		next := func() State {
			t.Helper()
			select {
			case s := <-changes:
				return s
			case <-time.After(5 * time.Second):
				t.Fatal("no onChange")
				return State{}
			}
		}
		h := got(t, acquire(f, ctx, "h", "another chat is answering"))
		if s := next(); !reflect.DeepEqual(s, State{Holder: "h", Waiting: []Waiting{}}) {
			t.Fatalf("after grant: %+v", s)
		}
		a := acquire(f, ctx, "a", "")
		want := State{Holder: "h", Waiting: []Waiting{{RunID: "a", Why: "another chat is answering"}}}
		if s := next(); !reflect.DeepEqual(s, want) {
			t.Fatalf("after a waits: %+v", s)
		}
		if s := f.State(); !reflect.DeepEqual(s, want) {
			t.Fatalf("State = %+v", s)
		}
		b := acquire(f, ctx, "b", "")
		next()
		h.lease.Release()
		want = State{Holder: "a", Waiting: []Waiting{{RunID: "b", Why: "another run is using the model"}}}
		if s := next(); !reflect.DeepEqual(s, want) {
			t.Fatalf("after release: %+v", s)
		}
		got(t, a).lease.Release()
		next()
		got(t, b).lease.Release()
		if s := next(); !reflect.DeepEqual(s, State{Waiting: []Waiting{}}) {
			t.Fatalf("after the last release: %+v", s)
		}
	})
}
