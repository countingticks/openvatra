//go:build windows

package host

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

var ErrNoProcess = errors.New("no such process")

// openProcess opens pid for waiting. ErrNoProcess when it does not exist or has
// already ended (a handle someone else still holds keeps an ended pid valid).
func openProcess(pid int) (windows.Handle, error) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return 0, ErrNoProcess
	}
	if err != nil {
		return 0, fmt.Errorf("open process %d: %w", pid, err)
	}
	if ev, _ := windows.WaitForSingleObject(h, 0); ev == windows.WAIT_OBJECT_0 {
		windows.CloseHandle(h)
		return 0, ErrNoProcess
	}
	return h, nil
}

// WatchParent calls onExit once, from a goroutine, when process pid ends.
func WatchParent(pid int, onExit func()) error {
	h, err := openProcess(pid)
	if err != nil {
		return err
	}
	go func() {
		windows.WaitForSingleObject(h, windows.INFINITE)
		windows.CloseHandle(h)
		onExit()
	}()
	return nil
}

// WaitExit waits up to timeout for process pid to end. true when it ended or was never there.
func WaitExit(pid int, timeout time.Duration) (bool, error) {
	h, err := openProcess(pid)
	if errors.Is(err, ErrNoProcess) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, uint32(timeout.Milliseconds()))
	switch {
	case ev == windows.WAIT_OBJECT_0:
		return true, nil
	case ev == uint32(windows.WAIT_TIMEOUT):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("wait for process %d: %w", pid, err)
	default:
		return false, fmt.Errorf("wait for process %d: unexpected result %#x", pid, ev)
	}
}
