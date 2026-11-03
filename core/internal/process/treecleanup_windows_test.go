//go:build windows

package process

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const helperEnv = "OPENVATRA_JOB_HELPER"

// TestJobHelper is not a real test: the test below re-runs this binary to act as
// a stand-in for core.exe (joins a job, starts a server, prints its PID, then waits).
func TestJobHelper(t *testing.T) {
	if os.Getenv(helperEnv) == "" {
		t.Skip("only runs as a child of TestJobObjectKillsServersWhenParentDies")
	}
	if err := SetupTreeCleanup(); err != nil {
		fmt.Println("setup error:", err)
		os.Exit(1)
	}
	port, _ := FreePort()
	p := New(Config{Path: fakeServer, Args: []string{"-port", fmt.Sprint(port)}, Port: port})
	if err := p.Start(context.Background(), 10*time.Second); err != nil {
		fmt.Println("start error:", err)
		os.Exit(1)
	}
	fmt.Println("pid", p.cmd.Process.Pid)
	time.Sleep(time.Minute) // the parent kills us long before this
}

func TestJobObjectKillsServersWhenParentDies(t *testing.T) {
	helper := exec.Command(os.Args[0], "-test.run=^TestJobHelper$")
	helper.Env = append(os.Environ(), helperEnv+"=1", "OPENVATRA_FAKE_SERVER="+fakeServer)
	out, err := helper.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer helper.Process.Kill()

	var pid uint32
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatalf("helper printed nothing: %v", err)
	}
	if _, err := fmt.Sscanf(line, "pid %d", &pid); err != nil {
		t.Fatalf("helper said %q", line)
	}

	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		t.Fatalf("server %d is not running: %v", pid, err)
	}
	defer windows.CloseHandle(h)

	// Hard kill: no deferred cleanup runs, so only the job object can save us from an orphan.
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	ev, _ := windows.WaitForSingleObject(h, 10_000)
	if ev != windows.WAIT_OBJECT_0 {
		t.Fatalf("server %d still alive after its parent was killed", pid)
	}
}
