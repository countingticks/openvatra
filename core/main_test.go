package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
)

func TestWriteReadyIsOneJSONLine(t *testing.T) {
	var buf bytes.Buffer
	if err := writeReady(&buf, 53121); err != nil {
		t.Fatal(err)
	}

	var got struct {
		Event   string `json:"event"`
		Port    int    `json:"port"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if got.Event != "ready" || got.Port != 53121 || got.Version != version {
		t.Fatalf("got %+v", got)
	}
	if bytes.Count(buf.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("want exactly one line, got %q", buf.String())
	}
}

func TestWatchStdinFiresWhenPipeCloses(t *testing.T) {
	r, w := io.Pipe()
	fired := make(chan struct{})
	go watchStdin(r, func() { close(fired) })

	select {
	case <-fired:
		t.Fatal("fired before stdin closed")
	case <-time.After(50 * time.Millisecond):
	}
	w.Close()
	select {
	case <-fired:
	case <-time.After(time.Second):
		t.Fatal("did not fire after stdin closed")
	}
}

// startCore runs the real run() on a free port and returns its port and exit channel.
func startCore(t *testing.T, stdin io.Reader) (int, <-chan error) {
	t.Helper()
	t.Setenv(tokenEnv, "tok")
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- run(nil, stdin, pw) }()
	var ready struct{ Port int }
	if err := json.NewDecoder(pr).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, pr)
	return ready.Port, done
}

func waitExit(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run returned %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("core did not exit")
	}
}

func TestRunStopsOnShutdownRequest(t *testing.T) {
	stdinR, stdinW := io.Pipe() // stays open: only /shutdown may stop us
	defer stdinW.Close()
	port, done := startCore(t, stdinR)

	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/shutdown", port), nil)
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", resp.StatusCode)
	}
	waitExit(t, done)
}

func TestRunStopsWhenStdinCloses(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	_, done := startCore(t, stdinR)

	stdinW.Close()
	waitExit(t, done)
}

func TestOptionArgs(t *testing.T) {
	ctx, cpu := 8192, 0
	got := optionArgs(config.ModelOptions{ContextSize: &ctx, GPULayers: &cpu, ExtraArgs: []string{"--flash-attn", "on"}})
	want := []string{"--ctx-size", "8192", "--n-gpu-layers", "0", "--flash-attn", "on"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	if got := optionArgs(config.ModelOptions{}); len(got) != 0 {
		t.Fatalf("no options gave %v", got)
	}
}
