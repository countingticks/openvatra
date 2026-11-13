//go:build windows

package main

import (
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
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
	t.Setenv(tokenEnv, "")
	parent := startSleeper(t)
	dir := t.TempDir()
	_, done := startCoreWith(t, []string{"--data-dir", dir, "--parent-pid", strconv.Itoa(parent.Process.Pid)},
		strings.NewReader(""))
	readDiscovery(t, dir) // serving

	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitExit(t, done)
	assertNoDiscovery(t, dir)
}

func TestRunRefusesAParentThatIsGone(t *testing.T) {
	t.Setenv(tokenEnv, "")
	parent := startSleeper(t)
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	parent.Wait()
	dir := t.TempDir()

	err := run([]string{"--data-dir", dir, "--parent-pid", strconv.Itoa(parent.Process.Pid)}, strings.NewReader(""),
		io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("err = %v, want one saying the parent is not running", err)
	}
	assertNoDiscovery(t, dir)
}
