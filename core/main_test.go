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
	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/engine/llamaserver"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/fit"
	"github.com/countingticks/openvatra/core/internal/host"
	"github.com/countingticks/openvatra/core/internal/hw"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/provider/llamacpp"
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

// startCore runs the real run() on a free port in a new data folder.
func startCore(t *testing.T) (host.Discovery, <-chan error) {
	t.Helper()
	return startCoreWith(t, []string{"--data-dir", t.TempDir()})
}

// startCoreWith runs the real run() with args, which must hold --data-dir, and returns what core publishes in
// core.json (polled for up to 5 s) and its exit channel.
func startCoreWith(t *testing.T, args []string) (host.Discovery, <-chan error) {
	t.Helper()
	i := slices.Index(args, "--data-dir")
	if i < 0 || i+1 >= len(args) {
		t.Fatal("startCoreWith needs --data-dir")
	}
	dir := args[i+1]
	done := make(chan error, 1)
	go func() { done <- run(args, io.Discard, io.Discard) }()
	d, err := pollDiscovery(dir, done)
	if err != nil {
		t.Fatal(err)
	}
	return d, done
}

// waitDiscovery polls dir's core.json for up to 5 s.
func waitDiscovery(t *testing.T, dir string) host.Discovery {
	t.Helper()
	d, err := pollDiscovery(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// pollDiscovery reads dir's core.json until it appears; exited, when given, ends the wait early if core stops first.
func pollDiscovery(dir string, exited <-chan error) (host.Discovery, error) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		d, err := host.ReadDiscovery(dir)
		if err == nil {
			return d, nil
		}
		select {
		case runErr := <-exited:
			return d, fmt.Errorf("core exited before writing core.json: %v", runErr)
		default:
		}
		if time.Now().After(deadline) {
			return d, err
		}
		time.Sleep(10 * time.Millisecond)
	}
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

func assertNoDiscovery(t *testing.T, dir string) {
	t.Helper()
	if _, err := host.ReadDiscovery(dir); !errors.Is(err, host.ErrNoDiscovery) {
		t.Fatalf("core.json is still there (read error: %v)", err)
	}
}

var hexToken = regexp.MustCompile(`^[0-9a-f]{64}$`)

func TestRunWritesCoreJSONWithItsOwnToken(t *testing.T) {
	dir := t.TempDir()
	llama := t.TempDir()
	d, done := startCoreWith(t, []string{"--data-dir", dir, "--port", "0", "--llama-dir", llama})
	port := d.Port
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

func TestRunNeverLogsItsToken(t *testing.T) {
	logDir := t.TempDir()
	t.Setenv(logDirEnv, logDir)
	d, done := startCoreWith(t, []string{"--data-dir", t.TempDir()})

	token := d.Token
	shutdown(t, d.Port, token)
	waitExit(t, done)
	log, err := os.ReadFile(filepath.Join(logDir, "core.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(log, []byte(token)) {
		t.Fatal("core.log contains the token")
	}
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
		err := run([]string{pair[0], pair[1], "--data-dir", t.TempDir()}, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), pair[0]) || !strings.Contains(err.Error(), pair[1]) {
			t.Errorf("%s %s: err = %v, want one naming both", pair[0], pair[1], err)
		}
	}
}

func TestDetachAndStopNeedADataFolder(t *testing.T) {
	for _, mode := range []string{"--detach", "--stop"} {
		err := run([]string{mode}, io.Discard, io.Discard)
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
	err := run([]string{"--stop", "--data-dir", dir}, io.Discard, &stderr)
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
	d, done := startCore(t)

	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/shutdown", d.Port), nil)
	req.Header.Set("Authorization", "Bearer "+d.Token)
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

func TestModelArgs(t *testing.T) {
	c := llamacpp.LlamaCppSettings{Options: map[string]llamacpp.ModelOptions{"qwen": {Args: "--temp 0.7"}}}.Resolve("")
	got := modelArgs(c, "qwen")
	if want := []string{"--temp", "0.7"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	if got := modelArgs(c, "other"); len(got) != 0 {
		t.Fatalf("a model without options got %v, want none", got)
	}
	// The list is a copy: writing into it must never change the config.
	got[1] = "x"
	if again := modelArgs(c, "qwen"); again[1] != "0.7" {
		t.Fatalf("config args changed: %v", again)
	}
}

// resolved builds the effective config for a test from the qwen model's argument text ("" = no options).
func resolved(qwenArgs string) llamacpp.Resolved {
	m := llamacpp.LlamaCppSettings{Options: map[string]llamacpp.ModelOptions{}}
	if qwenArgs != "" {
		m.Options["qwen"] = llamacpp.ModelOptions{Args: qwenArgs}
	}
	return m.Resolve("")
}

func TestSpecFor(t *testing.T) {
	m := models.Model{ID: "qwen", Kind: models.KindChat, Path: `D:\m\qwen.gguf`, MMProj: `D:\m\mmproj-qwen.gguf`,
		Shape: engine.Shape{FileBytes: 100, ProjectorBytes: 10, Layers: 4}}
	noProj := m.Shape
	noProj.ProjectorBytes = 0
	choice := &fit.Choice{Context: 32768, Placement: fit.PlaceLayers, Layers: 3}
	layers := engine.Placement{Kind: engine.PlaceLayers, Layers: 3}
	cases := map[string]struct {
		c         llamacpp.Resolved
		m         models.Model
		embedding bool
		want      engine.Spec
	}{
		"projector on by default": {resolved(""), m, false,
			engine.Spec{Model: "qwen", Path: m.Path, Projector: m.MMProj, Context: 32768, Placement: layers, Shape: m.Shape}},
		"no-mmproj in args": {resolved("--no-mmproj"), m, false,
			engine.Spec{Model: "qwen", Path: m.Path, Context: 32768, Placement: layers, Shape: noProj, Args: []string{"--no-mmproj"}}},
		"user's own args": {resolved("--temp 0.7"), m, false,
			engine.Spec{Model: "qwen", Path: m.Path, Projector: m.MMProj, Context: 32768, Placement: layers, Shape: m.Shape, Args: []string{"--temp", "0.7"}}},
		"embedding has no context and no placement": {resolved(""), m, true,
			engine.Spec{Model: "qwen", Path: m.Path, Embedding: true}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := specFor(tc.c, tc.m, tc.embedding, choice)
			if len(got.Args) == 0 {
				got.Args = nil // no user args: empty and nil mean the same
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("spec = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// plain is a needsFor that answers the same whatever the spec.
func plain(needs fit.Needs) needsFor { return func(engine.Spec) fit.Needs { return needs } }

func TestChoiceFor(t *testing.T) {
	shape := engine.Shape{FileBytes: 1 << 30, ProjectorBytes: 1 << 20, Layers: 32, KVHeads: 8, KeyLen: 128, ValueLen: 128,
		MaxContext: 131072}
	chat := models.Model{ID: "qwen", Kind: models.KindChat, MMProj: "mmproj.gguf", Shape: shape}
	report := hw.Report{GPU: &hw.GPU{TotalBytes: 24 << 30}, RAMBytes: 64 << 30}
	// recording is a needs func that keeps every shape it is asked about and says everything is small.
	recording := func(shapes *[]engine.Shape) fit.Needs {
		return func(s engine.Spec) engine.Resources {
			*shapes = append(*shapes, s.Shape)
			return engine.Resources{VRAMBytes: 1 << 30, Known: true, Source: "estimate"}
		}
	}
	options := func(o llamacpp.ModelOptions) llamacpp.Resolved {
		return llamacpp.LlamaCppSettings{Options: map[string]llamacpp.ModelOptions{"qwen": o}}.Resolve("")
	}

	t.Run("an embedding model has none", func(t *testing.T) {
		var shapes []engine.Shape
		embed := models.Model{ID: "qwen", Kind: models.KindEmbedding, Shape: shape}
		if got := choiceFor(options(llamacpp.ModelOptions{}), embed, report, plain(recording(&shapes)), 0, "auto"); got != nil {
			t.Fatalf("choice = %+v, want nil", got)
		}
	})
	t.Run("a projector that is off does not count", func(t *testing.T) {
		var shapes []engine.Shape
		if got := choiceFor(options(llamacpp.ModelOptions{Args: "--no-mmproj"}), chat, report, plain(recording(&shapes)), 0, "auto"); got == nil {
			t.Fatal("choice = nil")
		}
		for _, s := range shapes {
			if s.ProjectorBytes != 0 {
				t.Fatalf("needs saw ProjectorBytes %d, want 0", s.ProjectorBytes)
			}
		}
		shapes = nil
		choiceFor(options(llamacpp.ModelOptions{}), chat, report, plain(recording(&shapes)), 0, "auto")
		if len(shapes) == 0 || shapes[0].ProjectorBytes != 1<<20 {
			t.Fatalf("with the projector on, needs saw %+v", shapes)
		}
	})
	t.Run("the stored context and placement reach the choice", func(t *testing.T) {
		var shapes []engine.Shape
		c := options(llamacpp.ModelOptions{Context: new(4096), Placement: "cpu"})
		got := chosen(c, chat, report, plain(recording(&shapes)))
		if got == nil || got.Context != 4096 || got.Placement != fit.PlaceCPU {
			t.Fatalf("choice = %+v, want 4096 on the CPU", got)
		}
	})
}

func TestFitModel(t *testing.T) {
	shape := engine.Shape{FileBytes: 1 << 30, Layers: 32, KVHeads: 8, KeyLen: 128, ValueLen: 128, MaxContext: 131072}
	found := []models.Model{
		{ID: "qwen", Kind: models.KindChat, Shape: shape},
		{ID: "nomic", Kind: models.KindEmbedding, Shape: shape},
	}
	report := hw.Report{GPU: &hw.GPU{TotalBytes: 24 << 30}, RAMBytes: 64 << 30}
	needs := func(engine.Spec) engine.Resources {
		return engine.Resources{VRAMBytes: 1 << 30, Known: true, Source: "estimate"}
	}
	stored := llamacpp.LlamaCppSettings{Options: map[string]llamacpp.ModelOptions{
		"qwen": {Context: new(4096), Placement: "gpu"},
	}}.Resolve("")

	t.Run("an embedding model is unknown", func(t *testing.T) {
		if _, err := fitModel(stored, found, "nomic", report, plain(needs), 0, "auto"); !errors.Is(err, provider.ErrUnknownModel) {
			t.Fatalf("err = %v, want ErrUnknownModel", err)
		}
	})
	t.Run("a missing model is unknown", func(t *testing.T) {
		if _, err := fitModel(stored, found, "nope", report, plain(needs), 0, "auto"); !errors.Is(err, provider.ErrUnknownModel) {
			t.Fatalf("err = %v, want ErrUnknownModel", err)
		}
	})
	t.Run("the query's placement and size override the stored ones", func(t *testing.T) {
		got, err := fitModel(stored, found, "qwen", report, plain(needs), 8192, fit.PlaceCPU)
		if err != nil || got.Placement != fit.PlaceCPU || got.Context != 8192 {
			t.Fatalf("choice = %+v, err = %v, want 8192 on the CPU", got, err)
		}
	})
}

func TestTestCatalogFlagFailsOnMissingOrInvalidFile(t *testing.T) {
	t.Setenv(logDirEnv, t.TempDir())
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`[{"id":"x"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{filepath.Join(t.TempDir(), "missing.json"), bad} {
		args := []string{"--test-catalog", file, "--data-dir", t.TempDir()}
		if err := run(args, io.Discard, io.Discard); err == nil {
			t.Fatalf("run accepted test catalog %s", file)
		}
	}
}

func TestRunCreatesTheDataFolderAndDatabase(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	d, done := startCoreWith(t, []string{"--data-dir", dir, "--llama-dir", t.TempDir()})

	if _, err := os.Stat(filepath.Join(dir, "openvatra.db")); err != nil {
		t.Fatal("database not created:", err)
	}
	shutdown(t, d.Port, d.Token)
	waitExit(t, done)
}

func TestRunIgnoresTheOldTokenVariable(t *testing.T) {
	t.Setenv("OPENVATRA_CORE_TOKEN", "tok")
	d, done := startCore(t)

	if d.Token == "tok" || !hexToken.MatchString(d.Token) {
		t.Errorf("core.json token = %q, want 64 hex characters of its own", d.Token)
	}
	shutdown(t, d.Port, d.Token)
	waitExit(t, done)
}

func TestPlainRunWritesNothingToStdout(t *testing.T) {
	var out bytes.Buffer // read only after run returns, so no lock is needed
	dir := t.TempDir()
	done := make(chan error, 1)
	go func() { done <- run([]string{"--data-dir", dir}, &out, io.Discard) }()
	d := waitDiscovery(t, dir)
	shutdown(t, d.Port, d.Token)
	waitExit(t, done)

	if out.Len() != 0 {
		t.Fatalf("stdout = %q, want nothing", out.String())
	}
}

// A models row split by config.SplitModels must decode strictly into the owners' types: Register logs and falls back
// to the defaults otherwise, so this proves the section names and the JSON config writes match theirs.
func TestSplitModelsRowsRegisterIntact(t *testing.T) {
	cases := map[string]struct {
		old, engine, provider string
		providerRev           int // 2 when UpgradeOptions rewrote the split row
	}{
		"default row": {
			`{"llamaServerPath":null,"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,"options":{},"engine":"bundled"}`,
			`{"path":null,"build":"auto"}`,
			`{"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,"options":{}}`,
			1,
		},
		"full row": {
			`{"llamaServerPath":"C:\\llama\\llama-server.exe","modelsDir":"D:\\Models","embeddingModel":"nomic",` +
				`"idleUnloadMinutes":30,"options":{"a":{"args":"-c 4096"},"b":{}},"engine":"cuda"}`,
			`{"path":"C:\\llama\\llama-server.exe","build":"cuda"}`,
			`{"modelsDir":"D:\\Models","embeddingModel":"nomic","idleUnloadMinutes":30,"options":{"a":{"context":4096},"b":{}}}`,
			2,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			st, err := store.Open(t.TempDir(), event.NewBus(16))
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			if _, err := st.ConfigPut(context.Background(), "models", 0, []byte(tc.old)); err != nil {
				t.Fatal(err)
			}
			var log bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&log, nil))
			if err := config.SplitModels(context.Background(), st, logger); err != nil {
				t.Fatal(err)
			}
			if err := llamacpp.UpgradeOptions(context.Background(), st, logger); err != nil {
				t.Fatal(err)
			}
			cfg := config.New(st, logger)
			registerSections(cfg, llamaserver.Env{}, "")
			for section, want := range map[string]struct {
				rev   int
				value string
			}{llamaserver.ID: {1, tc.engine}, llamacpp.ID: {tc.providerRev, tc.provider}} {
				e, err := cfg.Section(section)
				if err != nil {
					t.Fatal(err)
				}
				if e.Rev != want.rev || string(e.Value) != want.value {
					t.Errorf("%s = rev %d, %s; want rev %d, %s", section, e.Rev, e.Value, want.rev, want.value)
				}
			}
			if strings.Contains(log.String(), "level=ERROR") {
				t.Fatalf("log = %s", log.String())
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
	err := run(nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "--data-dir") {
		t.Fatalf("err = %v, want one naming --data-dir", err)
	}
}

func TestRunExitsWithCode3WhenTheFolderIsLocked(t *testing.T) {
	dir := t.TempDir()
	lock, err := host.Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()

	err = run([]string{"--data-dir", dir}, io.Discard, io.Discard)
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
	var buf bytes.Buffer
	if err := run(append([]string{"--openapi"}, args...), &buf, io.Discard); err != nil {
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
		err := run([]string{"--origin", bad}, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "--origin") {
			t.Fatalf("--origin %s: err = %v, want one naming --origin", bad, err)
		}
	}
	args := []string{"--origin", "http://localhost:5173", "--origin", "http://127.0.0.1:5173", "--openapi"}
	if err := run(args, io.Discard, io.Discard); err != nil {
		t.Fatalf("two valid --origin values: %v", err)
	}
}

// unknownNeeds knows nothing about any model.
func unknownNeeds(engine.Spec) engine.Resources { return engine.Resources{} }

func TestToProviderModels(t *testing.T) {
	found := []models.Model{
		{ID: "qwen", Kind: models.KindChat, MMProj: "mmproj.gguf"},
		{ID: "broken", Kind: models.KindUnreadable},
		{ID: "embed", Kind: models.KindEmbedding, MMProj: "mmproj.gguf"},
	}
	resolve := func(m llamacpp.LlamaCppSettings) llamacpp.Resolved { return m.Resolve("") }

	t.Run("a chat model with a projector has Vision", func(t *testing.T) {
		got := toProviderModels(resolve(llamacpp.LlamaCppSettings{}), found, hw.Report{}, plain(unknownNeeds))
		// Nothing is known about the hardware, so the chat model loads at fit's default.
		if len(got) != 2 || got[0] != (provider.Model{ID: "qwen", Kind: provider.ModelChat, Vision: true, Context: fit.DefaultContext}) {
			t.Fatalf("models = %+v", got)
		}
	})
	t.Run("--no-mmproj takes Vision away", func(t *testing.T) {
		got := toProviderModels(resolve(llamacpp.LlamaCppSettings{Options: map[string]llamacpp.ModelOptions{"qwen": {Args: "--no-mmproj"}}}), found, hw.Report{}, plain(unknownNeeds))
		if got[0].Vision {
			t.Fatalf("models = %+v", got)
		}
	})
	t.Run("unreadable models are left out and embedding models have no Vision", func(t *testing.T) {
		got := toProviderModels(resolve(llamacpp.LlamaCppSettings{}), found, hw.Report{}, plain(unknownNeeds))
		if len(got) != 2 || got[1] != (provider.Model{ID: "embed", Kind: provider.ModelEmbedding}) {
			t.Fatalf("models = %+v", got)
		}
	})
}

// estimateOf is a needs func with a fixed estimate of vram bytes for every spec.
func estimateOf(vram int64) fit.Needs {
	return func(engine.Spec) engine.Resources {
		return engine.Resources{VRAMBytes: vram, Known: true, Source: "estimate"}
	}
}

func TestMeasuredNeeds(t *testing.T) {
	const gib = 1 << 30
	rows := []store.ModelFit{
		{FitPlace: store.FitPlace{Context: 8192, Placement: "gpu"}, Memory: true, VRAMBytes: 3 * gib, RAMBytes: 100, TokensPerSecond: 24},
		{FitPlace: store.FitPlace{Context: 16384, Placement: "gpu"}, TokensPerSecond: 12},
		{FitPlace: store.FitPlace{Context: 8192, Placement: "layers", Layers: 12}, Memory: true, VRAMBytes: gib, RAMBytes: 2 * gib},
		{FitPlace: store.FitPlace{Context: 65536, Placement: "experts"}, Memory: true, VRAMBytes: gib, RAMBytes: 2 * gib, GPUExpertLayers: 16},
	}
	needs := measuredNeeds(rows, estimateOf(5*gib))
	layers := func(n int) engine.Placement { return engine.Placement{Kind: engine.PlaceLayers, Layers: n} }
	cases := map[string]struct {
		spec engine.Spec
		want engine.Resources
	}{
		"a memory row": {engine.Spec{Context: 8192},
			engine.Resources{VRAMBytes: 3 * gib, RAMBytes: 100, Known: true, Source: "measured", TokensPerSecond: 24}},
		"a speed-only row keeps the estimate and adds the speed": {engine.Spec{Context: 16384},
			engine.Resources{VRAMBytes: 5 * gib, Known: true, Source: "estimate", TokensPerSecond: 12}},
		"layers 12": {engine.Spec{Context: 8192, Placement: layers(12)},
			engine.Resources{VRAMBytes: gib, RAMBytes: 2 * gib, Known: true, Source: "measured"}},
		"layers 20 is not answered by 12": {engine.Spec{Context: 8192, Placement: layers(20)},
			engine.Resources{VRAMBytes: 5 * gib, Known: true, Source: "estimate"}},
		"expert layers come with a memory row": {engine.Spec{Context: 65536, Placement: engine.Placement{Kind: engine.PlaceExperts}},
			engine.Resources{VRAMBytes: gib, RAMBytes: 2 * gib, Known: true, Source: "measured", GPUExpertLayers: 16}},
		"no row": {engine.Spec{Context: 32768},
			engine.Resources{VRAMBytes: 5 * gib, Known: true, Source: "estimate"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := needs(tc.spec); got != tc.want {
				t.Fatalf("needs = %+v, want %+v", got, tc.want)
			}
		})
	}
	t.Run("a speed-only row on an unknown estimate stays unknown", func(t *testing.T) {
		got := measuredNeeds(rows, unknownNeeds)(engine.Spec{Context: 16384})
		if got != (engine.Resources{}) {
			t.Fatalf("needs = %+v, want nothing", got)
		}
	})
}

func TestMeasuredNeedsGivesTheEstimateTheModelsArgs(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	want := []string{"-ctk", "f16"}
	var seen [][]string
	rec := func(s engine.Spec) engine.Resources {
		seen = append(seen, s.Args)
		return engine.Resources{}
	}
	path := filepath.Join(t.TempDir(), "m.gguf")
	if err := os.WriteFile(path, make([]byte, 10), 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(t.TempDir(), event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cases := map[string]struct {
		db   *store.Store
		path string
	}{
		"no database":          {nil, ""},
		"unreadable file":      {db, filepath.Join(t.TempDir(), "missing.gguf")},
		"a store with no rows": {db, path},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			seen = nil
			spec := engine.Spec{Model: "m", Path: c.path, Args: want}
			measuredNeedsFor(c.db, rec, logger)(spec)(engine.Spec{Context: 8192})
			if len(seen) != 1 || !slices.Equal(seen[0], want) {
				t.Fatalf("the estimate saw args %v, want [%v]", seen, want)
			}
		})
	}
}

// measuredFixture is a chat model with a real file, an empty store, and the report of a 24 GiB GPU.
type measuredFixture struct {
	db     *store.Store
	m      models.Model
	report hw.Report
	needs  needsFor
}

func newMeasuredFixture(t *testing.T, estimate fit.Needs) *measuredFixture {
	t.Helper()
	db, err := store.Open(t.TempDir(), event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	path := filepath.Join(t.TempDir(), "qwen.gguf")
	if err := os.WriteFile(path, make([]byte, 1000), 0o644); err != nil {
		t.Fatal(err)
	}
	return &measuredFixture{
		db:     db,
		m:      models.Model{ID: "qwen", Kind: models.KindChat, Path: path, Shape: engine.Shape{FileBytes: 1000, MaxContext: 131072}},
		report: hw.Report{GPU: &hw.GPU{TotalBytes: 24 << 30}, RAMBytes: 64 << 30},
		needs:  measuredNeedsFor(db, estimate, slog.New(slog.NewTextHandler(io.Discard, nil))),
	}
}

func (f *measuredFixture) record(t *testing.T, c llamacpp.Resolved, m llamacpp.Measurement) {
	t.Helper()
	if rec := recordFunc(f.db, slog.New(slog.NewTextHandler(io.Discard, nil))); rec == nil {
		t.Fatal("recordFunc is nil with a database")
	} else {
		rec(m)
	}
}

func TestAutoPrefersAMeasuredSizeThatFits(t *testing.T) {
	const gib = 1 << 30
	// The estimate says nothing from 32K up fits in 24 GiB; a real load at 32K used 10 GiB.
	estimate := func(s engine.Spec) engine.Resources {
		vram := int64(gib)
		if s.Context >= 32768 {
			vram = 100 * gib
		}
		return engine.Resources{VRAMBytes: vram, Known: true, Source: "estimate"}
	}
	f := newMeasuredFixture(t, estimate)
	c := resolved("")
	got := choiceFor(c, f.m, f.report, f.needs, 0, "auto")
	if got == nil || got.Context != 16384 || got.Source != "estimate" {
		t.Fatalf("before a load: choice = %+v, want 16K by estimate", got)
	}
	spec := specFor(c, f.m, false, &fit.Choice{Context: 32768, Placement: fit.PlaceGPU})
	f.record(t, c, llamacpp.Measurement{Spec: spec, Memory: engine.Resources{VRAMBytes: 10 * gib, Known: true, Source: "measured"}})
	got = choiceFor(c, f.m, f.report, f.needs, 0, "auto")
	if got == nil || got.Context != 32768 || got.Placement != fit.PlaceGPU || got.Source != "measured" {
		t.Fatalf("after a load: choice = %+v, want gpu at 32K, measured", got)
	}
}

func TestFitAnswersMeasuredOnlyForTheSizeLoaded(t *testing.T) {
	f := newMeasuredFixture(t, estimateOf(1<<30))
	c := resolved("")
	spec := specFor(c, f.m, false, &fit.Choice{Context: 8192, Placement: fit.PlaceGPU})
	f.record(t, c, llamacpp.Measurement{Spec: spec, Memory: engine.Resources{VRAMBytes: 2 << 30, Known: true, Source: "measured"}})
	f.record(t, c, llamacpp.Measurement{Spec: spec, TokensPerSecond: 24})
	found := []models.Model{f.m}

	got, err := fitModel(c, found, "qwen", f.report, f.needs, 8192, fit.PlaceGPU)
	if err != nil || got.Source != "measured" || got.TokensPerSecond != 24 || got.VRAMBytes != 2<<30 {
		t.Fatalf("the size loaded: choice = %+v, err = %v", got, err)
	}
	got, err = fitModel(c, found, "qwen", f.report, f.needs, 16384, fit.PlaceGPU)
	if err != nil || got.Source != "estimate" || got.TokensPerSecond != 0 {
		t.Fatalf("another size: choice = %+v, err = %v", got, err)
	}
}

func TestMeasurementsStopCountingWhenTheModelChanges(t *testing.T) {
	f := newMeasuredFixture(t, estimateOf(1<<30))
	c := resolved("")
	spec := specFor(c, f.m, false, &fit.Choice{Context: 8192, Placement: fit.PlaceGPU})
	f.record(t, c, llamacpp.Measurement{Spec: spec, Memory: engine.Resources{VRAMBytes: 2 << 30, Known: true, Source: "measured"}})
	f.record(t, c, llamacpp.Measurement{Spec: spec, TokensPerSecond: 24})

	if got := choiceFor(c, f.m, f.report, f.needs, 8192, fit.PlaceGPU); got.Source != "measured" || got.TokensPerSecond != 24 {
		t.Fatalf("a load and then an answer: choice = %+v, want one measured choice", got)
	}
	if got := choiceFor(resolved("--jinja"), f.m, f.report, f.needs, 8192, fit.PlaceGPU); got.Source != "estimate" {
		t.Fatalf("other args: choice = %+v, want an estimate", got)
	}
	// The file is rewritten with another size.
	if err := os.WriteFile(f.m.Path, make([]byte, 2000), 0o644); err != nil {
		t.Fatal(err)
	}
	f.m.Shape.FileBytes = 2000
	if got := choiceFor(c, f.m, f.report, f.needs, 8192, fit.PlaceGPU); got.Source != "estimate" || got.TokensPerSecond != 0 {
		t.Fatalf("another file: choice = %+v, want an estimate", got)
	}
}

func TestWithoutADatabaseNothingIsRecordedOrMeasured(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if recordFunc(nil, logger) != nil {
		t.Fatal("recordFunc has a function without a database")
	}
	m := models.Model{ID: "qwen", Kind: models.KindChat, Shape: engine.Shape{FileBytes: 1000, MaxContext: 131072}}
	report := hw.Report{GPU: &hw.GPU{TotalBytes: 24 << 30}, RAMBytes: 64 << 30}
	needs := measuredNeedsFor(nil, estimateOf(1<<30), logger)
	if got := choiceFor(resolved(""), m, report, needs, 8192, fit.PlaceGPU); got.Source != "estimate" {
		t.Fatalf("choice = %+v, want an estimate", got)
	}
}
