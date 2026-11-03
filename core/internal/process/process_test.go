package process

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

var fakeServer string

// TestMain compiles the fake server once; every test then runs it as if it were llama-server.
func TestMain(m *testing.M) {
	// The Job Object test re-runs this binary and hands over the server it already built.
	if path := os.Getenv("OPENVATRA_FAKE_SERVER"); path != "" {
		fakeServer = path
		os.Exit(m.Run())
	}
	dir, err := os.MkdirTemp("", "fake-server")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fakeServer = filepath.Join(dir, "fake-server")
	if runtime.GOOS == "windows" {
		fakeServer += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", fakeServer, "../../testdata/fake-server").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "building fake server: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func newFake(t *testing.T, extra ...string) *Process {
	t.Helper()
	port, err := FreePort()
	if err != nil {
		t.Fatal(err)
	}
	args := append([]string{"-port", fmt.Sprint(port)}, extra...)
	p := New(Config{Path: fakeServer, Args: args, Port: port})
	t.Cleanup(func() { p.Stop(time.Second) })
	return p
}

func get(t *testing.T, url string) (int, error) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func TestStartBecomesReadyThenStopKillsIt(t *testing.T) {
	p := newFake(t)
	if err := p.Start(context.Background(), 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if p.State() != StateReady {
		t.Fatalf("state = %s, want ready", p.State())
	}
	if code, err := get(t, p.BaseURL()+"/v1/models"); err != nil || code != 200 {
		t.Fatalf("GET /v1/models = %d, %v", code, err)
	}

	p.Stop(5 * time.Second)
	if p.State() != StateStopped {
		t.Fatalf("state after stop = %s, want stopped", p.State())
	}
	if _, err := get(t, p.BaseURL()+"/health"); err == nil {
		t.Fatal("server still answers after Stop")
	}
}

func TestStartWaitsWhileModelLoads(t *testing.T) {
	p := newFake(t, "-load-time", "1s")
	begin := time.Now()
	if err := p.Start(context.Background(), 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if time.Since(begin) < time.Second {
		t.Fatalf("ready after %v, before the fake finished loading", time.Since(begin))
	}
}

func TestStartTimesOutAndStopsTheProcess(t *testing.T) {
	p := newFake(t, "-load-time", "1m")
	err := p.Start(context.Background(), time.Second)
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if p.State() != StateStopped {
		t.Fatalf("state = %s, want stopped", p.State())
	}
	if _, err := get(t, p.BaseURL()+"/health"); err == nil {
		t.Fatal("timed-out server was left running")
	}
}

func TestStartFailsWhenProcessExitsEarly(t *testing.T) {
	p := newFake(t, "-exit", "3")
	if err := p.Start(context.Background(), 10*time.Second); err == nil {
		t.Fatal("expected an error for a process that exits at once")
	}
	if p.State() != StateStopped {
		t.Fatalf("state = %s, want stopped", p.State())
	}
}

func TestStartFailsForMissingProgram(t *testing.T) {
	p := New(Config{Path: filepath.Join(t.TempDir(), "nope.exe"), Port: 1})
	if err := p.Start(context.Background(), time.Second); err == nil {
		t.Fatal("expected an error")
	}
	if p.State() != StateStopped {
		t.Fatalf("state = %s, want stopped", p.State())
	}
}

func TestStartCanBeCancelled(t *testing.T) {
	p := newFake(t, "-load-time", "1m")
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(500 * time.Millisecond); cancel() }()
	if err := p.Start(ctx, 30*time.Second); err == nil {
		t.Fatal("expected a cancellation error")
	}
	if p.State() != StateStopped {
		t.Fatalf("state = %s, want stopped", p.State())
	}
}

func TestStartRefusesWhenAlreadyRunning(t *testing.T) {
	p := newFake(t)
	if err := p.Start(context.Background(), 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := p.Start(context.Background(), time.Second); err == nil {
		t.Fatal("second Start should fail")
	}
}
