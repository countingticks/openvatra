package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/store"
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

func TestModelArgs(t *testing.T) {
	c := config.Models{Options: map[string]config.ModelOptions{"qwen": {Args: "-c 131072"}}}.Resolve(config.Env{})
	got := modelArgs(c, "qwen")
	if want := []string{"-c", "131072"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	if got := modelArgs(c, "other"); len(got) != 0 {
		t.Fatalf("a model without options got %v, want none", got)
	}
	// The list is a copy: writing into it must never change the config.
	got[1] = "x"
	if again := modelArgs(c, "qwen"); again[1] != "131072" {
		t.Fatalf("config args changed: %v", again)
	}
}

// resolved builds the effective config for a test from the qwen model's argument text ("" = no options).
func resolved(qwenArgs string) config.Resolved {
	m := config.Models{Options: map[string]config.ModelOptions{}}
	if qwenArgs != "" {
		m.Options["qwen"] = config.ModelOptions{Args: qwenArgs}
	}
	return m.Resolve(config.Env{})
}

func TestServerArgsProjector(t *testing.T) {
	m := models.Model{ID: "qwen", Path: `D:\m\qwen.gguf`, MMProj: `D:\m\mmproj-qwen.gguf`}
	core := []string{"-m", m.Path, "--host", "127.0.0.1", "--port", "8000"}
	base := append(slices.Clone(core), "-c", "16384")
	withProjector := append(slices.Clone(base), "--mmproj", m.MMProj)
	cases := map[string]struct {
		c         config.Resolved
		m         models.Model
		embedding bool
		want      []string
	}{
		"on by default":     {resolved(""), m, false, withProjector},
		"no-mmproj in args": {resolved("--no-mmproj"), m, false, append(slices.Clone(base), "--no-mmproj")},
		"none found":        {resolved(""), models.Model{ID: "qwen", Path: m.Path}, false, base},
		"embedding server":  {resolved(""), m, true, append(slices.Clone(core), "--embeddings")},
		"before user's own": {resolved("-c 4096"), m, false, append(slices.Clone(withProjector), "-c", "4096")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := serverArgs(tc.c, tc.m, 8000, tc.embedding); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("args = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTestCatalogFlagFailsOnMissingOrInvalidFile(t *testing.T) {
	t.Setenv(tokenEnv, "t")
	t.Setenv(logDirEnv, t.TempDir())
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`[{"id":"x"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{filepath.Join(t.TempDir(), "missing.json"), bad} {
		if err := run([]string{"--test-catalog", file}, strings.NewReader(""), io.Discard); err == nil {
			t.Fatalf("run accepted test catalog %s", file)
		}
	}
}

func TestRunCreatesTheDataFolderAndDatabase(t *testing.T) {
	t.Setenv(tokenEnv, "tok")
	dir := filepath.Join(t.TempDir(), "data")
	stdinR, stdinW := io.Pipe()
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- run([]string{"--data-dir", dir, "--llama-dir", t.TempDir()}, stdinR, pw) }()
	if err := json.NewDecoder(pr).Decode(&struct{ Port int }{}); err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, pr)

	if _, err := os.Stat(filepath.Join(dir, "openvatra.db")); err != nil {
		t.Fatal("database not created:", err)
	}
	stdinW.Close()
	waitExit(t, done)
}

func TestResolveFrom(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cfg := config.New(db, nil)
	env := config.Env{LlamaDir: t.TempDir(), Home: t.TempDir()}
	config.Register(cfg, config.ModelsSection, config.DefaultModels(), effectiveModels(env))
	override := config.NewOverride()

	r := resolveFrom(override, cfg, env)
	if want := filepath.Join(env.LlamaDir, "llama-server.exe"); r.LlamaServerPath != want {
		t.Errorf("default LlamaServerPath = %q, want %q", r.LlamaServerPath, want)
	}
	if want := filepath.Join(env.Home, "OpenVatra", "Models"); r.ModelsDir != want {
		t.Errorf("default ModelsDir = %q, want %q", r.ModelsDir, want)
	}

	stored := filepath.Join(t.TempDir(), "stored")
	section := config.DefaultModels()
	section.ModelsDir = &stored
	value, _ := json.Marshal(section)
	if _, err := cfg.Put(config.ModelsSection, 0, value); err != nil {
		t.Fatal(err)
	}
	if got := resolveFrom(override, cfg, env).ModelsDir; got != stored {
		t.Errorf("after a Put ModelsDir = %q, want %q", got, stored)
	}

	server, folder := filepath.Join(t.TempDir(), "server.exe"), filepath.Join(t.TempDir(), "override")
	posted := config.DefaultModels()
	posted.LlamaServerPath, posted.ModelsDir = &server, &folder
	if err := override.Set(posted); err != nil {
		t.Fatal(err)
	}
	if got := resolveFrom(override, cfg, env); got.LlamaServerPath != server || got.ModelsDir != folder {
		t.Errorf("with the override = %q, %q, want %q, %q", got.LlamaServerPath, got.ModelsDir, server, folder)
	}
}
