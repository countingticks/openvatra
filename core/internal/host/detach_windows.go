//go:build windows

package host

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// Detach starts exe with args as a core that outlives its starter (no console,
// own process group, out of the starter's job when allowed) and waits for it to
// be ready. args must not contain --detach.
func Detach(exe string, args []string, dataDir string, timeout time.Duration) (Ready, error) {
	breakaway := true
	cmd, err := startDetached(exe, args, true)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// The starter's job forbids breakaway: the core then dies with that job.
		breakaway = false
		cmd, err = startDetached(exe, args, false)
	}
	if err != nil {
		return Ready{}, fmt.Errorf("start core: %w", err)
	}
	ready, err := WaitReady(cmdChild{cmd}, func() (Discovery, error) { return ReadDiscovery(dataDir) }, timeout)
	if err != nil {
		return Ready{}, err
	}
	cmd.Process.Release()
	ready.Breakaway = breakaway
	return ready, nil
}

func startDetached(exe string, args []string, breakaway bool) (*exec.Cmd, error) {
	flags := uint32(windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP)
	if breakaway {
		flags |= windows.CREATE_BREAKAWAY_FROM_JOB
	}
	cmd := exec.Command(exe, args...)
	// Stdin, Stdout and Stderr stay nil (NUL) and Env nil (inherited).
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags, HideWindow: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

type cmdChild struct{ cmd *exec.Cmd }

func (c cmdChild) Pid() int    { return c.cmd.Process.Pid }
func (c cmdChild) Kill() error { return c.cmd.Process.Kill() }

func (c cmdChild) Wait() (int, error) {
	err := c.cmd.Wait()
	var exitErr *exec.ExitError
	if err == nil || errors.As(err, &exitErr) {
		return c.cmd.ProcessState.ExitCode(), nil
	}
	return -1, err
}
