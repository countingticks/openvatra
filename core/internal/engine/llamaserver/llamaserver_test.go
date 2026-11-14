package llamaserver

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/engine/enginetest"
	"github.com/countingticks/openvatra/core/internal/seam"
)

var fakeServer string

// TestMain compiles the fake server once; every test then runs it as if it were llama-server.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fake-server")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fakeServer = filepath.Join(dir, "fake-server")
	if runtime.GOOS == "windows" {
		fakeServer += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", fakeServer, "../../../testdata/fake-server").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "building fake server: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func fakePath() string { return fakeServer }

func TestEngineContract(t *testing.T) {
	ready := engine.Spec{Model: "fake", Path: "model.gguf", Context: 16384}
	never := ready
	never.Args = []string{"-load-time", "1m"}
	enginetest.Run(t, enginetest.Fixture{
		New:        func(*testing.T) engine.Engine { return New(fakePath, nil) },
		Ready:      ready,
		NeverReady: never,
	})
}

func TestCommand(t *testing.T) {
	core := []string{"-m", "P", "--host", "127.0.0.1"}
	cases := map[string]struct {
		spec engine.Spec
		want []string
	}{
		"chat":             {engine.Spec{Path: "P", Context: 16384}, append(slices.Clone(core), "-c", "16384")},
		"projector":        {engine.Spec{Path: "P", Context: 16384, Projector: "M"}, append(slices.Clone(core), "-c", "16384", "--mmproj", "M")},
		"embedding":        {engine.Spec{Path: "P", Embedding: true, Projector: "M"}, append(slices.Clone(core), "--embeddings")},
		"no context":       {engine.Spec{Path: "P"}, core},
		"user's args last": {engine.Spec{Path: "P", Context: 16384, Projector: "M", Args: []string{"-c", "4096"}}, append(slices.Clone(core), "-c", "16384", "--mmproj", "M", "-c", "4096")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := New(func() string { return "llama-server.exe" }, nil).Command(tc.spec)
			want := engine.Command{Path: "llama-server.exe", Args: tc.want, PortFlag: "--port", Health: "/health"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("command = %+v, want %+v", got, want)
			}
		})
	}
}

func TestCommandReadsThePathEachTime(t *testing.T) {
	path := "a.exe"
	e := New(func() string { return path }, nil)
	if got := e.Command(engine.Spec{}).Path; got != "a.exe" {
		t.Fatalf("path = %s", got)
	}
	path = "b.exe"
	if got := e.Command(engine.Spec{}).Path; got != "b.exe" {
		t.Fatalf("path = %s after a change", got)
	}
}

func TestStartLogsWithModelPrefix(t *testing.T) {
	var out bytes.Buffer
	e := New(fakePath, &out)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	inst, err := e.Start(ctx, engine.Spec{Model: "fake", Path: "model.gguf"})
	if err != nil {
		t.Fatal(err)
	}
	inst.Stop(5 * time.Second) // the buffer is read only after the process and its output copier are gone
	if !strings.HasPrefix(out.String(), "[fake] fake-server listening") {
		t.Fatalf("log = %q, want the start-up line prefixed [fake] ", out.String())
	}
}

func TestCheck(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "llama-server.exe")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "nope.exe")
	cases := map[string]struct {
		path string
		want seam.Health
	}{
		"empty":   {"", seam.Health{Reason: "No llama-server.exe found."}},
		"missing": {missing, seam.Health{Reason: "No llama-server.exe found at " + missing + "."}},
		"folder":  {dir, seam.Health{Reason: "No llama-server.exe found at " + dir + "."}},
		"file":    {file, seam.Health{OK: true}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := New(func() string { return tc.path }, nil).Check(context.Background()); got != tc.want {
				t.Fatalf("health = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestNeedsIsUnknown(t *testing.T) {
	if got := New(fakePath, nil).Needs(engine.Spec{}); got.Known {
		t.Fatalf("Needs = %+v, want Known false", got)
	}
}
