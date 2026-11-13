//go:build windows

package host

import (
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestSleepHelper is not a real test: the tests below re-run this binary as a
// process to wait on.
func TestSleepHelper(t *testing.T) {
	if os.Getenv(helperEnv) != "sleep" {
		t.Skip("only runs as a child of the pid tests")
	}
	time.Sleep(30 * time.Second)
}

func startSleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestSleepHelper$")
	cmd.Env = append(os.Environ(), helperEnv+"=sleep")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	return cmd
}

// exitedPid returns the pid of a helper that was started, killed and waited for.
func exitedPid(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestSleepHelper$")
	cmd.Env = append(os.Environ(), helperEnv+"=sleep")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	cmd.Process.Kill()
	cmd.Wait()
	return pid
}

func TestWatchParentCallsOnExitWhenProcessEnds(t *testing.T) {
	cmd := startSleeper(t)
	exited := make(chan struct{}, 2)
	if err := WatchParent(cmd.Process.Pid, func() { exited <- struct{}{} }); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
		t.Fatal("onExit called while the process still runs")
	case <-time.After(200 * time.Millisecond):
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		t.Fatal("onExit not called within 2 s of the process ending")
	}
}

func TestWatchParentOnExitedPid(t *testing.T) {
	called := false
	err := WatchParent(exitedPid(t), func() { called = true })
	if !errors.Is(err, ErrNoProcess) {
		t.Errorf("err = %v, want ErrNoProcess", err)
	}
	if called {
		t.Error("onExit called for a process that was already gone")
	}
}

func TestWaitExitOnRunningThenKilledProcess(t *testing.T) {
	cmd := startSleeper(t)
	gone, err := WaitExit(cmd.Process.Pid, 100*time.Millisecond)
	if gone || err != nil {
		t.Fatalf("running process: %v, %v; want false, nil", gone, err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	gone, err = WaitExit(cmd.Process.Pid, 2*time.Second)
	if !gone || err != nil {
		t.Errorf("killed process: %v, %v; want true, nil", gone, err)
	}
}

func TestWaitExitOnExitedPidReturnsAtOnce(t *testing.T) {
	pid := exitedPid(t)
	start := time.Now()
	gone, err := WaitExit(pid, 5*time.Second)
	if !gone || err != nil {
		t.Errorf("exited process: %v, %v; want true, nil", gone, err)
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("took %v, want at once", took)
	}
}
