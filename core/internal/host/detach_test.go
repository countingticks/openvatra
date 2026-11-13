package host

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const childPID = 4242

type fakeChild struct {
	exit   chan int
	killed atomic.Bool
}

func newFakeChild() *fakeChild { return &fakeChild{exit: make(chan int, 1)} }

func (c *fakeChild) Pid() int           { return childPID }
func (c *fakeChild) Wait() (int, error) { return <-c.exit, nil }

func (c *fakeChild) Kill() error {
	c.killed.Store(true)
	select {
	case c.exit <- 1:
	default:
	}
	return nil
}

// fakeFile stands in for core.json: read returns whatever was last set, and
// counts its calls.
type fakeFile struct {
	mu    sync.Mutex
	d     Discovery
	err   error
	calls int
	// onRead, when set, runs before each read with the call number (1-based).
	onRead func(f *fakeFile, call int)
}

func (f *fakeFile) read() (Discovery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.onRead != nil {
		f.onRead(f, f.calls)
	}
	return f.d, f.err
}

func (f *fakeFile) set(d Discovery, err error) {
	f.d, f.err = d, err
}

var errNoFile = ErrNoDiscovery

func TestWaitReadyReturnsWhenFileAppears(t *testing.T) {
	file := &fakeFile{err: errNoFile, onRead: func(f *fakeFile, call int) {
		if call == 3 {
			f.set(Discovery{PID: childPID, Port: 51234, Version: "0.1.0"}, nil)
		}
	}}
	got, err := WaitReady(newFakeChild(), file.read, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	want := Ready{Port: 51234, PID: childPID, Version: "0.1.0"}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if file.calls != 3 {
		t.Errorf("returned after %d polls, want 3", file.calls)
	}
}

func TestWaitReadyIgnoresAnotherPid(t *testing.T) {
	file := &fakeFile{onRead: func(f *fakeFile, call int) {
		if call < 4 {
			f.set(Discovery{PID: 1111, Port: 1}, nil)
		} else {
			f.set(Discovery{PID: childPID, Port: 2}, nil)
		}
	}}
	got, err := WaitReady(newFakeChild(), file.read, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != 2 || file.calls != 4 {
		t.Errorf("got port %d after %d polls, want port 2 after 4", got.Port, file.calls)
	}
}

func TestWaitReadyKeepsPollingOnReadErrors(t *testing.T) {
	file := &fakeFile{onRead: func(f *fakeFile, call int) {
		if call < 3 {
			f.set(Discovery{}, errors.New("parse core.json: unexpected end of JSON input"))
		} else {
			f.set(Discovery{PID: childPID, Port: 3}, nil)
		}
	}}
	got, err := WaitReady(newFakeChild(), file.read, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != 3 {
		t.Errorf("got port %d, want 3", got.Port)
	}
}

func TestWaitReadyChildExits(t *testing.T) {
	tests := []struct {
		name  string
		code  int
		check func(t *testing.T, err error)
	}{
		{"code 3 means another core runs", 3, func(t *testing.T, err error) {
			if !errors.Is(err, ErrRunning) {
				t.Errorf("err = %v, want ErrRunning", err)
			}
		}},
		// The file with the child's pid is readable too: the exit still counts.
		{"code 1 is an error naming the code", 1, func(t *testing.T, err error) {
			if err == nil || errors.Is(err, ErrRunning) || errors.Is(err, ErrTimeout) || !strings.Contains(err.Error(), "code 1") {
				t.Errorf("err = %v, want an exit error naming code 1", err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			child := newFakeChild()
			child.exit <- tt.code
			file := &fakeFile{d: Discovery{PID: childPID, Port: 1}}
			_, err := WaitReady(child, file.read, 5*time.Second)
			tt.check(t, err)
		})
	}
}

func TestWaitReadyTimesOutAndKills(t *testing.T) {
	child := newFakeChild()
	file := &fakeFile{err: errNoFile}
	_, err := WaitReady(child, file.read, 200*time.Millisecond)
	if !errors.Is(err, ErrTimeout) {
		t.Errorf("err = %v, want ErrTimeout", err)
	}
	if !child.killed.Load() {
		t.Error("the child was not killed")
	}
}
