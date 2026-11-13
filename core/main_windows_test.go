//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/host"
)

const mainHelperEnv = "OPENVATRA_MAIN_HELPER"

// TestSleepHelper is not a real test: the tests below re-run this binary to get a process they can kill.
func TestSleepHelper(t *testing.T) {
	if os.Getenv(mainHelperEnv) != "sleep" {
		t.Skip("only runs as a helper process of the --parent-pid tests")
	}
	time.Sleep(30 * time.Second)
}

// startSleeper starts a TestSleepHelper process; the test kills it at the end if it has not already.
func startSleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestSleepHelper$")
	cmd.Env = append(os.Environ(), mainHelperEnv+"=sleep")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	return cmd
}

func TestRunStopsWhenTheParentEnds(t *testing.T) {
	parent := startSleeper(t)
	dir := t.TempDir()
	_, done := startCoreWith(t, []string{"--data-dir", dir, "--parent-pid", strconv.Itoa(parent.Process.Pid)})

	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitExit(t, done)
	assertNoDiscovery(t, dir)
}

// coreExe runs this test binary as core.exe with args and returns its stdout and exit code.
func coreExe(t *testing.T, logDir string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = append(os.Environ(), coreMainEnv+"=1", logDirEnv+"="+logDir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		t.Fatal(err)
	}
	if stderr.Len() > 0 {
		t.Logf("core %v stderr: %s", args, stderr.String())
	}
	return stdout.String(), cmd.ProcessState.ExitCode()
}

func TestDetachStartsACoreThatOutlivesTheLauncher(t *testing.T) {
	dir := t.TempDir()
	llama := t.TempDir()
	logDir := t.TempDir()
	t.Cleanup(func() { coreExe(t, logDir, "--stop", "--data-dir", dir) }) // before the folders above are removed

	out, code := coreExe(t, logDir, "--detach", "--data-dir", dir, "--llama-dir", llama)
	if code != 0 {
		t.Fatalf("launcher exit code = %d, want 0 (stdout %q)", code, out)
	}
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("launcher printed %q, want one line", out)
	}
	var ready struct {
		Event string
		Port  int
		PID   int
	}
	if err := json.Unmarshal([]byte(out), &ready); err != nil || ready.Event != "ready" {
		t.Fatalf("ready line %q (err %v)", out, err)
	}
	if ready.PID == os.Getpid() || ready.PID == 0 {
		t.Fatalf("ready pid = %d, want the started core's", ready.PID)
	}

	d := waitDiscovery(t, dir)
	if d.PID != ready.PID {
		t.Fatalf("core.json pid = %d, ready line pid = %d", d.PID, ready.PID)
	}
	if code := request(t, http.MethodGet, ready.Port, "/health", d.Token); code != http.StatusOK {
		t.Fatalf("health status = %d after the launcher exited, want 200", code)
	}

	out, code = coreExe(t, logDir, "--detach", "--data-dir", dir, "--llama-dir", llama)
	if code != 3 || strings.TrimSpace(out) != `{"event":"running"}` {
		t.Fatalf("second launcher: exit %d, stdout %q; want 3 and the running line", code, out)
	}

	if _, code := coreExe(t, logDir, "--stop", "--data-dir", dir); code != 0 {
		t.Fatalf("--stop exit code = %d, want 0", code)
	}
	if gone, err := host.WaitExit(ready.PID, 0); err != nil || !gone {
		t.Fatalf("core still running after --stop (err %v)", err)
	}
	assertNoDiscovery(t, dir)
}

func TestRunRefusesAParentThatIsGone(t *testing.T) {
	parent := startSleeper(t)
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	parent.Wait()
	dir := t.TempDir()

	err := run([]string{"--data-dir", dir, "--parent-pid", strconv.Itoa(parent.Process.Pid)}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("err = %v, want one saying the parent is not running", err)
	}
	assertNoDiscovery(t, dir)
}
