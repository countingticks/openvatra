package engine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

// probePort returns a port that is free now, so a test knows where a failed start would have listened.
func probePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// startFake runs the fake server through a Runner whose port is known, with a deadline of timeout.
func startFake(t *testing.T, timeout time.Duration, ctx context.Context, extra ...string) (Instance, int, error) {
	t.Helper()
	port := probePort(t)
	r := &Runner{port: func() (int, error) { return port, nil }}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	inst, err := r.Start(ctx, Command{Path: fakeServer, Args: extra, PortFlag: "-port", Health: "/health"}, nil)
	if inst != nil {
		t.Cleanup(func() { inst.Stop(time.Second) })
	}
	return inst, port, err
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

func nothingAnswers(t *testing.T, port int) {
	t.Helper()
	if _, err := get(t, fmt.Sprintf("http://127.0.0.1:%d/health", port)); err == nil {
		t.Fatal("a server still answers on the port")
	}
}

func TestStartBecomesReadyThenStopKillsIt(t *testing.T) {
	inst, port, err := startFake(t, 10*time.Second, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if inst.State() != StateReady {
		t.Fatalf("state = %s, want ready", inst.State())
	}
	if code, err := get(t, inst.BaseURL()+"/v1/models"); err != nil || code != 200 {
		t.Fatalf("GET /v1/models = %d, %v", code, err)
	}

	inst.Stop(5 * time.Second)
	if inst.State() != StateStopped {
		t.Fatalf("state after stop = %s, want stopped", inst.State())
	}
	nothingAnswers(t, port)
}

func TestStartWaitsWhileModelLoads(t *testing.T) {
	begin := time.Now()
	if _, _, err := startFake(t, 10*time.Second, context.Background(), "-load-time", "1s"); err != nil {
		t.Fatal(err)
	}
	if time.Since(begin) < time.Second {
		t.Fatalf("ready after %v, before the fake finished loading", time.Since(begin))
	}
}

func TestStartDeadlineEndsTheStartAndStopsTheProcess(t *testing.T) {
	inst, port, err := startFake(t, time.Second, context.Background(), "-load-time", "1m")
	if err == nil || err.Error() != "health check timed out after 1s" {
		t.Fatalf("err = %v, want health check timed out after 1s", err)
	}
	if inst != nil {
		t.Fatal("an instance came back with the error")
	}
	nothingAnswers(t, port)
}

func TestStartCanBeCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(500 * time.Millisecond); cancel() }()
	inst, port, err := startFake(t, 30*time.Second, ctx, "-load-time", "1m")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if inst != nil {
		t.Fatal("an instance came back with the error")
	}
	nothingAnswers(t, port)
}

func TestStartFailsWhenProcessExitsEarly(t *testing.T) {
	inst, _, err := startFake(t, 10*time.Second, context.Background(), "-exit", "3")
	if err == nil {
		t.Fatal("expected an error for a process that exits at once")
	}
	if inst != nil {
		t.Fatal("an instance came back with the error")
	}
}

func TestStartFailsForMissingProgram(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nope.exe")
	var r Runner
	inst, err := r.Start(context.Background(), Command{Path: path, PortFlag: "--port", Health: "/health"}, nil)
	if err == nil || !strings.Contains(err.Error(), path) {
		t.Fatalf("err = %v, want one naming %s", err, path)
	}
	if inst != nil {
		t.Fatal("an instance came back with the error")
	}
}

func TestPortFlagAndPortComeAfterTheCommandsArgs(t *testing.T) {
	// The fake only listens where -port says; ready on the chosen port means the flag reached it intact.
	inst, port, err := startFake(t, 10*time.Second, context.Background(), "-load-time", "0s")
	if err != nil {
		t.Fatal(err)
	}
	if want := fmt.Sprintf("http://127.0.0.1:%d", port); inst.BaseURL() != want {
		t.Fatalf("BaseURL = %s, want %s", inst.BaseURL(), want)
	}
	if code, err := get(t, inst.BaseURL()+"/health"); err != nil || code != 200 {
		t.Fatalf("GET /health = %d, %v", code, err)
	}
}

func TestStopTwiceAndWait(t *testing.T) {
	inst, _, err := startFake(t, 10*time.Second, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	inst.Stop(5 * time.Second)
	inst.Stop(5 * time.Second)
	select {
	case <-inst.Wait():
	default:
		t.Fatal("Wait is not closed after Stop")
	}
}
