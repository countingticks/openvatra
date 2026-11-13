package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/host"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/store"
)

// coreMainEnv makes the test binary act as core.exe: the launcher test starts it with --detach, and the launcher in
// turn starts it again as the host core.
const coreMainEnv = "OPENVATRA_CORE_MAIN"

func TestMain(m *testing.M) {
	if os.Getenv(coreMainEnv) == "1" {
		main() // exits
	}
	os.Exit(m.Run())
}

func TestWriteReadyIsOneJSONLine(t *testing.T) {
	var buf bytes.Buffer
	if err := writeReady(&buf, 53121, 4242); err != nil {
		t.Fatal(err)
	}

	var got struct {
		Event   string `json:"event"`
		Port    int    `json:"port"`
		PID     int    `json:"pid"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if got.Event != "ready" || got.Port != 53121 || got.PID != 4242 || got.Version != version {
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

// startCore runs the real run() in child mode on a free port and returns its port and exit channel.
func startCore(t *testing.T, stdin io.Reader) (int, <-chan error) {
	t.Helper()
	t.Setenv(tokenEnv, "tok")
	return startCoreWith(t, []string{"--data-dir", t.TempDir()}, stdin)
}

// startCoreWith runs the real run() with args and returns the port from its ready line and its exit channel.
func startCoreWith(t *testing.T, args []string, stdin io.Reader) (int, <-chan error) {
	t.Helper()
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- run(args, stdin, pw, io.Discard) }()
	var ready struct{ Port int }
	if err := json.NewDecoder(pr).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, pr)
	return ready.Port, done
}

// request sends one request to core with token and returns the status code.
func request(t *testing.T, method string, port int, path, token string) int {
	t.Helper()
	req, _ := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// shutdown sends POST /shutdown with token and fails the test unless core accepts it.
func shutdown(t *testing.T, port int, token string) {
	t.Helper()
	if code := request(t, http.MethodPost, port, "/shutdown", token); code != http.StatusAccepted {
		t.Fatalf("shutdown status = %d, want 202", code)
	}
}

// readDiscovery waits for core.json in dir (run writes it just after the ready line) and fails the test when it does
// not appear within 3 s.
func readDiscovery(t *testing.T, dir string) host.Discovery {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		d, err := host.ReadDiscovery(dir)
		if err == nil {
			return d
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertNoDiscovery(t *testing.T, dir string) {
	t.Helper()
	if _, err := host.ReadDiscovery(dir); !errors.Is(err, host.ErrNoDiscovery) {
		t.Fatalf("core.json is still there (read error: %v)", err)
	}
}

var hexToken = regexp.MustCompile(`^[0-9a-f]{64}$`)

func TestRunWritesCoreJSONWithItsOwnToken(t *testing.T) {
	t.Setenv(tokenEnv, "")
	dir := t.TempDir()
	llama := t.TempDir()
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	port, done := startCoreWith(t, []string{"--data-dir", dir, "--port", "0", "--llama-dir", llama}, stdinR)

	d := readDiscovery(t, dir)
	exe, err := exePath()
	if err != nil {
		t.Fatal(err)
	}
	if d.PID != os.Getpid() || d.Port != port || d.API != 1 || d.Version != version || d.Exe != exe {
		t.Errorf("core.json = pid %d port %d api %d version %q exe %q; want pid %d port %d api 1 version %q exe %q",
			d.PID, d.Port, d.API, d.Version, d.Exe, os.Getpid(), port, version, exe)
	}
	if !hexToken.MatchString(d.Token) {
		t.Errorf("token is not 64 lowercase hex characters (length %d)", len(d.Token))
	}
	if want := []string{"--data-dir", dir, "--llama-dir", llama}; !reflect.DeepEqual(d.Args, want) {
		t.Errorf("args = %v, want %v", d.Args, want)
	}
	shutdown(t, port, d.Token)
	waitExit(t, done)
	assertNoDiscovery(t, dir)
}

func TestRunPublishesTheTokenItWasGiven(t *testing.T) {
	t.Setenv(tokenEnv, "tok")
	dir := t.TempDir()
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	port, done := startCoreWith(t, []string{"--data-dir", dir}, stdinR)

	if d := readDiscovery(t, dir); d.Token != "tok" {
		t.Errorf("core.json token is not the one in %s", tokenEnv)
	}
	shutdown(t, port, "tok")
	waitExit(t, done)
}

func TestRunNeverLogsItsToken(t *testing.T) {
	t.Setenv(tokenEnv, "")
	logDir := t.TempDir()
	t.Setenv(logDirEnv, logDir)
	dir := t.TempDir()
	port, done := startCoreWith(t, []string{"--data-dir", dir}, strings.NewReader(""))

	token := readDiscovery(t, dir).Token
	shutdown(t, port, token)
	waitExit(t, done)
	log, err := os.ReadFile(filepath.Join(logDir, "core.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(log, []byte(token)) {
		t.Fatal("core.log contains the token")
	}
}

func TestRunWithoutAGivenTokenIgnoresStdin(t *testing.T) {
	t.Setenv(tokenEnv, "")
	dir := t.TempDir()
	stdinR, stdinW := io.Pipe()
	port, done := startCoreWith(t, []string{"--data-dir", dir}, stdinR)
	token := readDiscovery(t, dir).Token

	stdinW.Close()
	select {
	case err := <-done:
		t.Fatalf("core stopped when stdin closed (err %v)", err)
	case <-time.After(200 * time.Millisecond):
	}
	if code := request(t, http.MethodGet, port, "/health", token); code != http.StatusOK {
		t.Fatalf("health status = %d, want 200", code)
	}
	shutdown(t, port, token)
	waitExit(t, done)
}

func TestHostArgs(t *testing.T) {
	want := []string{"--data-dir", "d", "--origin", "o"}
	cases := map[string]struct {
		args []string
		want []string
	}{
		"separate values": {
			[]string{"--data-dir", "d", "--port", "0", "--detach", "--parent-pid", "12", "--origin", "o"}, want},
		"= forms": {
			[]string{"--data-dir", "d", "--port=0", "--detach=true", "--parent-pid=12", "--origin", "o"}, want},
		"single dash": {
			[]string{"--data-dir", "d", "-port", "0", "-detach", "-parent-pid", "12", "--origin", "o"}, want},
		"single dash, = forms": {
			[]string{"--data-dir", "d", "-port=0", "-detach=false", "-parent-pid=12", "--origin", "o"}, want},
		"nil": {nil, []string{}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got := hostArgs(c.args)
			if got == nil || !reflect.DeepEqual(got, c.want) {
				t.Fatalf("hostArgs = %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestModeFlagsAreExclusive(t *testing.T) {
	for _, pair := range [][2]string{{"--detach", "--stop"}, {"--openapi", "--stop"}, {"--openapi", "--detach"}} {
		err := run([]string{pair[0], pair[1], "--data-dir", t.TempDir()}, strings.NewReader(""), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), pair[0]) || !strings.Contains(err.Error(), pair[1]) {
			t.Errorf("%s %s: err = %v, want one naming both", pair[0], pair[1], err)
		}
	}
}

func TestDetachAndStopNeedADataFolder(t *testing.T) {
	for _, mode := range []string{"--detach", "--stop"} {
		err := run([]string{mode}, strings.NewReader(""), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--data-dir") {
			t.Errorf("%s: err = %v, want one naming --data-dir", mode, err)
		}
	}
}

// shorten sets *v to d for the rest of the test.
func shorten(t *testing.T, v *time.Duration, d time.Duration) {
	t.Helper()
	old := *v
	*v = d
	t.Cleanup(func() { *v = old })
}

// stopToken is the token in the core.json files the --stop tests write.
const stopToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// writeStopTarget writes a core.json naming port and pid into a new data folder and returns the folder.
func writeStopTarget(t *testing.T, port, pid int) string {
	t.Helper()
	dir := t.TempDir()
	if err := host.WriteDiscovery(dir, host.Discovery{PID: pid, Port: port, Token: stopToken}); err != nil {
		t.Fatal(err)
	}
	return dir
}

// runStop runs core --stop on dir and returns its stderr and error, failing the test if stderr holds the token.
func runStop(t *testing.T, dir string) (string, error) {
	t.Helper()
	var stderr bytes.Buffer
	err := run([]string{"--stop", "--data-dir", dir}, strings.NewReader(""), io.Discard, &stderr)
	if strings.Contains(stderr.String(), stopToken) {
		t.Errorf("stderr contains the token: %q", stderr.String())
	}
	return stderr.String(), err
}

// serverPort is the port an httptest server listens on.
func serverPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	port, err := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestStopWithoutACore(t *testing.T) {
	stderr, err := runStop(t, t.TempDir())
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if !strings.Contains(stderr, "no core is running") {
		t.Fatalf("stderr = %q, want it to say no core is running", stderr)
	}
}

func TestStopWithAStaleFileReturnsAtOnce(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	dir := writeStopTarget(t, port, os.Getpid()) // a live pid: waiting on it would time out

	start := time.Now()
	_, err = runStop(t, dir)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("--stop took %v on a closed port, want no wait", took)
	}
}

func TestStopSendsTheTokenAndTreatsARefusalAsNoCore(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	dir := writeStopTarget(t, serverPort(t, srv), os.Getpid())

	if _, err := runStop(t, dir); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if auth != "Bearer "+stopToken {
		t.Fatal("the request did not carry core.json's token")
	}
}

func TestStopWaitsOnAHungCoreAndFailsIfItStaysUp(t *testing.T) {
	shorten(t, &stopRequestTimeout, 100*time.Millisecond)
	shorten(t, &stopWait, 200*time.Millisecond)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) }) // runs first, so Close does not wait on the handler
	dir := writeStopTarget(t, serverPort(t, srv), os.Getpid())

	_, err := runStop(t, dir)
	if err == nil || !strings.Contains(err.Error(), strconv.Itoa(os.Getpid())) {
		t.Fatalf("err = %v, want one naming pid %d", err, os.Getpid())
	}
}

func TestDropFlagsKeepsFlagsItIsNotGiven(t *testing.T) {
	args := []string{"--data-dir", "d", "--port", "0", "--detach", "--parent-pid", "12", "--origin", "o"}
	got := dropFlags(args, []string{"detach"}, nil)
	want := []string{"--data-dir", "d", "--port", "0", "--parent-pid", "12", "--origin", "o"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dropFlags = %v, want %v", got, want)
	}
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
		args := []string{"--test-catalog", file, "--data-dir", t.TempDir()}
		if err := run(args, strings.NewReader(""), io.Discard, io.Discard); err == nil {
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
	go func() { done <- run([]string{"--data-dir", dir, "--llama-dir", t.TempDir()}, stdinR, pw, io.Discard) }()
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

func modelsEngine(t *testing.T, s sectionWriter) (string, int) {
	t.Helper()
	entry, err := s.Section(config.ModelsSection)
	if err != nil {
		t.Fatal(err)
	}
	var m config.Models
	if err := json.Unmarshal(entry.Value, &m); err != nil {
		t.Fatal(err)
	}
	return m.Engine, entry.Rev
}

func registeredStore(t *testing.T, withDB bool, logger *slog.Logger) *config.Store {
	t.Helper()
	var db config.DB
	if withDB {
		st, err := store.Open(t.TempDir(), event.NewBus(16))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { st.Close() })
		db = st
	}
	cfg := config.New(db, logger)
	config.Register(cfg, config.ModelsSection, config.DefaultModels(), effectiveModels(config.Env{LlamaDir: t.TempDir(), Home: t.TempDir()}))
	return cfg
}

func TestSwitchToCUDAStoresTheEngine(t *testing.T) {
	cfg := registeredStore(t, true, nil)
	var log bytes.Buffer
	switchToCUDA(cfg, slog.New(slog.NewTextHandler(&log, nil)))
	if engine, rev := modelsEngine(t, cfg); engine != "cuda" || rev != 1 {
		t.Fatalf("engine %q rev %d, want cuda and 1", engine, rev)
	}
	switchToCUDA(cfg, slog.New(slog.NewTextHandler(&log, nil)))
	if _, rev := modelsEngine(t, cfg); rev != 1 {
		t.Fatalf("rev after a second switch = %d, want 1 (already cuda)", rev)
	}
	if log.Len() != 0 {
		t.Fatalf("unexpected log: %s", log.String())
	}
}

func TestSwitchToCUDAWithoutADatabaseWarns(t *testing.T) {
	var log bytes.Buffer
	switchToCUDA(registeredStore(t, false, nil), slog.New(slog.NewTextHandler(&log, nil)))
	if !strings.Contains(log.String(), "level=WARN") || !strings.Contains(log.String(), "config storage is not available") {
		t.Fatalf("log = %q", log.String())
	}
}

// conflictingWriter answers ErrConflict to the first conflicts Puts and bumps the stored rev each time, like a
// competing writer would.
type conflictingWriter struct {
	value     json.RawMessage
	rev       int
	conflicts int
	putRevs   []int
}

func (c *conflictingWriter) Section(string) (config.SectionEntry, error) {
	return config.SectionEntry{Rev: c.rev, Value: c.value}, nil
}

func (c *conflictingWriter) Put(_ string, rev int, value json.RawMessage) (config.SectionEntry, error) {
	c.putRevs = append(c.putRevs, rev)
	if c.conflicts > 0 {
		c.conflicts--
		c.rev++
		return config.SectionEntry{}, config.ErrConflict
	}
	c.value, c.rev = value, rev+1
	return config.SectionEntry{Rev: c.rev, Value: value}, nil
}

func TestSwitchToCUDARetriesOnceOnConflict(t *testing.T) {
	value, _ := json.Marshal(config.DefaultModels())
	tests := []struct {
		name      string
		conflicts int
		wantPuts  []int
		wantCUDA  bool
		wantError bool
	}{
		{"one conflict", 1, []int{0, 1}, true, false},
		{"two conflicts", 2, []int{0, 1}, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := &conflictingWriter{value: value, conflicts: tt.conflicts}
			var log bytes.Buffer
			switchToCUDA(w, slog.New(slog.NewTextHandler(&log, nil)))
			if !slices.Equal(w.putRevs, tt.wantPuts) {
				t.Errorf("Put revs = %v, want %v", w.putRevs, tt.wantPuts)
			}
			if engine, _ := modelsEngine(t, w); (engine == "cuda") != tt.wantCUDA {
				t.Errorf("engine = %q, cuda wanted: %v", engine, tt.wantCUDA)
			}
			if got := strings.Count(log.String(), "level=ERROR"); (got == 1) != tt.wantError || got > 1 {
				t.Errorf("error lines = %d, want error: %v\n%s", got, tt.wantError, log.String())
			}
		})
	}
}

// fakeTrimmer records each cutoff and returns counts in turn (0 once they run out).
type fakeTrimmer struct {
	t       *testing.T
	cutoffs chan time.Time
	counts  []int64
}

func (f *fakeTrimmer) TrimSystem(ctx context.Context, before time.Time) (int64, error) {
	if ctx.Err() != nil {
		f.t.Error("trim called after the context ended")
	}
	f.cutoffs <- before
	var n int64
	if len(f.counts) > 0 {
		n, f.counts = f.counts[0], f.counts[1:]
	}
	return n, nil
}

func TestTrimSystemEventsRunsAtOnceThenOnSchedule(t *testing.T) {
	now := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	f := &fakeTrimmer{t: t, cutoffs: make(chan time.Time, 1000), counts: []int64{3}}
	var log bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		trimSystemEvents(ctx, f, 10*time.Millisecond, func() time.Time { return now }, slog.New(slog.NewTextHandler(&log, nil)))
		close(done)
	}()

	next := func() time.Time {
		t.Helper()
		select {
		case c := <-f.cutoffs:
			return c
		case <-time.After(5 * time.Second):
			t.Fatal("no trim")
			return time.Time{}
		}
	}
	want := now.Add(-30 * 24 * time.Hour)
	if c := next(); !c.Equal(want) {
		t.Fatalf("first cutoff = %v, want %v", c, want)
	}
	if c := next(); !c.Equal(want) {
		t.Fatalf("second cutoff = %v, want %v", c, want)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("trim loop did not stop")
	}
	if got := log.String(); strings.Count(got, "trimmed old system events") != 1 || !strings.Contains(got, "count=3") {
		t.Fatalf("log = %q", got)
	}
}

var update = flag.Bool("update", false, "rewrite api/openapi.json")

func TestRunRequiresADataFolder(t *testing.T) {
	t.Setenv(tokenEnv, "tok")
	err := run(nil, strings.NewReader(""), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "--data-dir") {
		t.Fatalf("err = %v, want one naming --data-dir", err)
	}
}

func TestRunExitsWithCode3WhenTheFolderIsLocked(t *testing.T) {
	t.Setenv(tokenEnv, "tok")
	dir := t.TempDir()
	lock, err := host.Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()

	err = run([]string{"--data-dir", dir}, strings.NewReader(""), io.Discard, io.Discard)
	if !errors.Is(err, host.ErrRunning) {
		t.Fatalf("err = %v, want host.ErrRunning", err)
	}
	if code := exitCode(err); code != 3 {
		t.Fatalf("exit code = %d, want 3", code)
	}
	for _, name := range []string{"core.json", "openvatra.db"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s exists after a refused start (stat error: %v)", name, err)
		}
	}
}

func TestExitCode(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"nil", nil, 0},
		{"running, wrapped", fmt.Errorf("start: %w", host.ErrRunning), 3},
		{"other", errors.New("x"), 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := exitCode(c.err); got != c.want {
				t.Fatalf("exitCode = %d, want %d", got, c.want)
			}
		})
	}
}

const openapiFile = "api/openapi.json"

func printOpenAPI(t *testing.T, args ...string) []byte {
	t.Helper()
	t.Setenv(tokenEnv, "")
	var buf bytes.Buffer
	if err := run(append([]string{"--openapi"}, args...), strings.NewReader(""), &buf, io.Discard); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestOpenAPIIsCurrent(t *testing.T) {
	got := printOpenAPI(t)
	if *update {
		if err := os.MkdirAll(filepath.Dir(openapiFile), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(openapiFile, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(openapiFile)
	if err != nil {
		t.Fatalf("%v\nrun: go -C core test . -run TestOpenAPI -update", err)
	}
	norm := func(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }
	if norm(got) != norm(want) {
		t.Error("core/api/openapi.json is stale\nrun: go -C core test . -run TestOpenAPI -update")
	}
}

func TestOpenAPIOpensNothing(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	printOpenAPI(t, "--data-dir", data)
	if _, err := os.Stat(data); !os.IsNotExist(err) {
		t.Errorf("the data folder exists after --openapi (stat error: %v)", err)
	}
}

func TestOpenAPIOutputIsADocument(t *testing.T) {
	var doc struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Version string `json:"version"`
		} `json:"info"`
	}
	if err := json.Unmarshal(printOpenAPI(t), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.OpenAPI != "3.1.0" || doc.Info.Version != version {
		t.Errorf("openapi %q, info.version %q", doc.OpenAPI, doc.Info.Version)
	}
}

func TestOriginFlag(t *testing.T) {
	for _, bad := range []string{"http://localhost:5173/app", "http://localhost:5173/", "http://localhost:5173?q",
		"http://localhost:5173#f", "localhost:5173", "null"} {
		err := run([]string{"--origin", bad}, strings.NewReader(""), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--origin") {
			t.Fatalf("--origin %s: err = %v, want one naming --origin", bad, err)
		}
	}
	args := []string{"--origin", "http://localhost:5173", "--origin", "http://127.0.0.1:5173", "--openapi"}
	if err := run(args, strings.NewReader(""), io.Discard, io.Discard); err != nil {
		t.Fatalf("two valid --origin values: %v", err)
	}
}
