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
	with := func(args ...string) []string { return append(slices.Clone(core), args...) }
	layers := func(n int) engine.Placement { return engine.Placement{Kind: engine.PlaceLayers, Layers: n} }
	cases := map[string]struct {
		spec engine.Spec
		want []string
	}{
		"gpu at 32768": {engine.Spec{Path: "P", Context: 32768}, with("-c", "32768", "-ngl", "all", "--fit", "off", "-lv", "4")},
		"experts": {engine.Spec{Path: "P", Context: 8192, Placement: engine.Placement{Kind: engine.PlaceExperts}},
			with("-c", "8192", "-ngl", "all", "--cpu-moe", "--fit", "off", "-lv", "4")},
		"layers 20":  {engine.Spec{Path: "P", Placement: layers(20)}, with("-ngl", "20", "--fit", "off", "-lv", "4")},
		"layers 0":   {engine.Spec{Path: "P", Placement: layers(0)}, with("-ngl", "0", "--fit", "off", "-lv", "4")},
		"cpu":        {engine.Spec{Path: "P", Placement: engine.Placement{Kind: engine.PlaceCPU}}, with("-ngl", "0", "--fit", "off", "-lv", "4")},
		"no context": {engine.Spec{Path: "P"}, with("-ngl", "all", "--fit", "off", "-lv", "4")},
		"projector and user's args last": {engine.Spec{Path: "P", Context: 16384, Projector: "M", Args: []string{"--temp", "0.7"}},
			with("-c", "16384", "-ngl", "all", "--fit", "off", "-lv", "4", "--mmproj", "M", "--temp", "0.7")},
		"embedding": {engine.Spec{Path: "P", Embedding: true, Context: 8192, Projector: "M", Placement: layers(3)},
			with("--embeddings")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := New(fakePath, nil).Command(tc.spec)
			want := engine.Command{Path: fakePath(), Args: tc.want, PortFlag: "--port", Health: "/health"}
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
	// Every flag core passes a chat server, so the fake is shown to accept them all.
	spec := engine.Spec{Model: "fake", Path: "model.gguf", Context: 8192, Projector: "mmproj.gguf",
		Placement: engine.Placement{Kind: engine.PlaceExperts}}
	inst, err := e.Start(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	inst.Stop(5 * time.Second) // the buffer is read only after the process and its output copier are gone
	if !strings.HasPrefix(out.String(), "[fake] fake-server listening") {
		t.Fatalf("log = %q, want the start-up line prefixed [fake] ", out.String())
	}
	if !strings.Contains(out.String(), "[fake] fake-server args: -m model.gguf --host 127.0.0.1 -c 8192 -ngl all --cpu-moe --fit off -lv 4 --mmproj mmproj.gguf --port ") {
		t.Fatalf("log = %q, want the arguments line", out.String())
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

func TestNeeds(t *testing.T) {
	const mib = 1 << 20
	dense := engine.Shape{
		FileBytes: 4000 * mib, ProjectorBytes: 100 * mib, Layers: 32, KVHeads: 4, KeyLen: 128, ValueLen: 128, MaxContext: 32768,
	}
	moe := dense
	moe.ExpertBytes = 3000 * mib
	// 8192 × 32 × 4 × 256 × 2 bytes
	const kv = 8192 * 32 * 4 * 256 * 2
	const fixed = 100*mib + kv + computeAllowance

	spec := func(s engine.Shape, p engine.Placement) engine.Spec {
		return engine.Spec{Shape: s, Context: 8192, Placement: p}
	}
	tests := []struct {
		name string
		spec engine.Spec
		want engine.Resources
	}{
		{"gpu", spec(dense, engine.Placement{}), engine.Resources{VRAMBytes: 4000*mib + fixed, Known: true, Source: "estimate"}},
		{"experts", spec(moe, engine.Placement{Kind: engine.PlaceExperts}),
			engine.Resources{VRAMBytes: 1000*mib + fixed, RAMBytes: 3000 * mib, Known: true, Source: "estimate"}},
		{"experts on a dense shape is gpu", spec(dense, engine.Placement{Kind: engine.PlaceExperts}),
			engine.Resources{VRAMBytes: 4000*mib + fixed, Known: true, Source: "estimate"}},
		{"layers", spec(dense, engine.Placement{Kind: engine.PlaceLayers, Layers: 8}),
			engine.Resources{VRAMBytes: 1000*mib + fixed, RAMBytes: 3000 * mib, Known: true, Source: "estimate"}},
		{"layers above the model's are clamped", spec(dense, engine.Placement{Kind: engine.PlaceLayers, Layers: 99}),
			engine.Resources{VRAMBytes: 4000*mib + fixed, Known: true, Source: "estimate"}},
		{"layers 0 puts the weights in RAM", spec(dense, engine.Placement{Kind: engine.PlaceLayers}),
			engine.Resources{VRAMBytes: fixed, RAMBytes: 4000 * mib, Known: true, Source: "estimate"}},
		{"cpu", spec(dense, engine.Placement{Kind: engine.PlaceCPU}),
			engine.Resources{RAMBytes: 4000*mib + fixed, Known: true, Source: "estimate"}},
		{"embedding", engine.Spec{Shape: dense, Context: 8192, Embedding: true}, engine.Resources{}},
		{"zero context", engine.Spec{Shape: dense}, engine.Resources{}},
	}
	for field, zero := range map[string]func(*engine.Shape){
		"FileBytes":  func(s *engine.Shape) { s.FileBytes = 0 },
		"Layers":     func(s *engine.Shape) { s.Layers = 0 },
		"KVHeads":    func(s *engine.Shape) { s.KVHeads = 0 },
		"KeyLen":     func(s *engine.Shape) { s.KeyLen = 0 },
		"ValueLen":   func(s *engine.Shape) { s.ValueLen = 0 },
		"MaxContext": func(s *engine.Shape) { s.MaxContext = 0 },
	} {
		s := dense
		zero(&s)
		tests = append(tests, struct {
			name string
			spec engine.Spec
			want engine.Resources
		}{"missing " + field, spec(s, engine.Placement{}), engine.Resources{}})
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := New(fakePath, nil).Needs(tt.spec); got != tt.want {
				t.Fatalf("Needs = %+v, want %+v", got, tt.want)
			}
		})
	}
}
