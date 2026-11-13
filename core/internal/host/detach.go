package host

import (
	"errors"
	"fmt"
	"time"
)

// ExitRunning is the exit code of a core that found the lock held.
const ExitRunning = 3

var (
	ErrRunning = errors.New("another core is already running on this data folder")
	ErrTimeout = errors.New("core did not write core.json in time")
)

// Ready is what the launcher reports once the started core wrote its discovery file.
type Ready struct {
	Port    int    `json:"port"`
	PID     int    `json:"pid"`
	Version string `json:"version"`
	// Breakaway is false when the core had to start inside the starter's job and
	// may die with it.
	Breakaway bool `json:"-"`
}

// Child is a started process as WaitReady sees it; detach_windows.go wraps *exec.Cmd in it.
type Child interface {
	Pid() int
	Wait() (code int, err error) // blocks until the process exits; err only when waiting itself failed
	Kill() error
}

const readyPoll = 50 * time.Millisecond

type exitResult struct {
	code int
	err  error
}

// WaitReady waits until read returns the discovery file of c, c exits, or timeout
// passes (then c is killed).
func WaitReady(c Child, read func() (Discovery, error), timeout time.Duration) (Ready, error) {
	exited := make(chan exitResult, 1)
	go func() {
		code, err := c.Wait()
		exited <- exitResult{code, err}
	}()
	tick := time.NewTicker(readyPoll)
	defer tick.Stop()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	for {
		select {
		case r := <-exited:
			return Ready{}, exitError(r)
		case <-deadline.C:
			c.Kill()
			return Ready{}, ErrTimeout
		case <-tick.C:
			// An exit wins over a file that appeared at the same moment.
			select {
			case r := <-exited:
				return Ready{}, exitError(r)
			default:
			}
			d, err := read()
			if err == nil && d.PID == c.Pid() {
				return Ready{Port: d.Port, PID: d.PID, Version: d.Version}, nil
			}
		}
	}
}

func exitError(r exitResult) error {
	if r.err != nil {
		return fmt.Errorf("wait for core: %w", r.err)
	}
	if r.code == ExitRunning {
		return ErrRunning
	}
	return fmt.Errorf("core exited with code %d before it was ready", r.code)
}
