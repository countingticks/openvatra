package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

func TestDefaultModels(t *testing.T) {
	d := DefaultModels()
	if err := d.Validate(); err != nil {
		t.Fatalf("defaults do not validate: %v", err)
	}
	if d.LlamaServerPath != nil || d.ModelsDir != nil || d.EmbeddingModel != nil {
		t.Errorf("paths and embedding = %v %v %v, want nil", d.LlamaServerPath, d.ModelsDir, d.EmbeddingModel)
	}
	if d.IdleUnloadMinutes == nil || *d.IdleUnloadMinutes != 15 {
		t.Errorf("idleUnloadMinutes = %v, want 15", d.IdleUnloadMinutes)
	}
	if d.Options == nil || len(d.Options) != 0 {
		t.Errorf("options = %v, want {}", d.Options)
	}
	if d.Engine != "bundled" {
		t.Errorf("engine = %q, want bundled", d.Engine)
	}
}

func TestValidateNamesTheField(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "x")
	cases := []struct {
		name   string
		change func(*Models)
		field  string
	}{
		{"empty llamaServerPath", func(m *Models) { m.LlamaServerPath = ptr("") }, "llamaServerPath"},
		{"relative llamaServerPath", func(m *Models) { m.LlamaServerPath = ptr(`bin\llama-server.exe`) }, "llamaServerPath"},
		{"NUL in llamaServerPath", func(m *Models) { m.LlamaServerPath = ptr(abs + "\x00") }, "llamaServerPath"},
		{"empty modelsDir", func(m *Models) { m.ModelsDir = ptr("") }, "modelsDir"},
		{"relative modelsDir", func(m *Models) { m.ModelsDir = ptr("Models") }, "modelsDir"},
		{"NUL in modelsDir", func(m *Models) { m.ModelsDir = ptr(abs + "\x00") }, "modelsDir"},
		{"empty embeddingModel", func(m *Models) { m.EmbeddingModel = ptr("") }, "embeddingModel"},
		{"idle 0", func(m *Models) { m.IdleUnloadMinutes = ptr(0) }, "idleUnloadMinutes"},
		{"idle 1441", func(m *Models) { m.IdleUnloadMinutes = ptr(1441) }, "idleUnloadMinutes"},
		{"empty model id", func(m *Models) { m.Options = map[string]ModelOptions{"": {}} }, "options has an empty model id"},
		{"nil options", func(m *Models) { m.Options = nil }, "options must be an object"},
		{"NUL in args", func(m *Models) { m.Options = map[string]ModelOptions{"m": {Args: "a\x00b"}} }, `options for "m": args must not contain a NUL character`},
		{"reserved flag", func(m *Models) { m.Options = map[string]ModelOptions{"m": {Args: "--port 1"}} }, `options for "m": --port`},
		{"open quote", func(m *Models) { m.Options = map[string]ModelOptions{"m": {Args: `"-c`}} }, `options for "m": A quote`},
		{"unknown engine", func(m *Models) { m.Engine = "vulkan" }, "engine"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := DefaultModels()
			tc.change(&m)
			err := m.Validate()
			if err == nil {
				t.Fatal("accepted")
			}
			if !strings.HasPrefix(err.Error(), tc.field) {
				t.Fatalf("error %q does not name %q", err, tc.field)
			}
		})
	}

	ok := DefaultModels()
	ok.LlamaServerPath, ok.ModelsDir, ok.EmbeddingModel = ptr(abs), ptr(abs), ptr("nomic")
	ok.IdleUnloadMinutes, ok.Engine = nil, "cuda"
	ok.Options["m"] = ModelOptions{Args: `-c 8192 --no-mmproj --chat-template-file "C:\my templates\t.jinja"`}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid value rejected: %v", err)
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolveLlamaServerPath(t *testing.T) {
	llamaDir, enginesDir := t.TempDir(), t.TempDir()
	bundled := filepath.Join(llamaDir, "llama-server.exe")
	cudaExe := filepath.Join(enginesDir, "b1-cuda", "llama-server.exe")
	set := filepath.Join(t.TempDir(), "my-server.exe")
	env := Env{LlamaDir: llamaDir, EnginesDir: enginesDir, Tag: "b1"}

	cuda := DefaultModels()
	cuda.Engine = "cuda"
	setPath := cuda
	setPath.LlamaServerPath = ptr(set)

	if got := cuda.Resolve(env).LlamaServerPath; got != bundled {
		t.Errorf("cuda without the file = %q, want the bundled %q", got, bundled)
	}
	writeFile(t, cudaExe)
	cases := []struct {
		name string
		m    Models
		env  Env
		want string
	}{
		{"set path wins over cuda", setPath, env, set},
		{"cuda present", cuda, env, cudaExe},
		{"cuda without a tag", cuda, Env{LlamaDir: llamaDir, EnginesDir: enginesDir}, bundled},
		{"bundled", DefaultModels(), env, bundled},
		{"no llama dir", DefaultModels(), Env{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.m.Resolve(tc.env).LlamaServerPath; got != tc.want {
				t.Fatalf("LlamaServerPath = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveModelsDir(t *testing.T) {
	home := t.TempDir()
	if got, want := DefaultModels().Resolve(Env{Home: home}).ModelsDir, filepath.Join(home, "OpenVatra", "Models"); got != want {
		t.Errorf("default ModelsDir = %q, want %q", got, want)
	}
	if got := DefaultModels().Resolve(Env{}).ModelsDir; got != "" {
		t.Errorf("without a home ModelsDir = %q, want empty", got)
	}
	set := DefaultModels()
	set.ModelsDir = ptr(filepath.Join(home, "elsewhere"))
	if got := set.Resolve(Env{Home: home}).ModelsDir; got != *set.ModelsDir {
		t.Errorf("set ModelsDir = %q, want %q", got, *set.ModelsDir)
	}
}

func TestIdleTimeout(t *testing.T) {
	m := DefaultModels()
	m.IdleUnloadMinutes = nil
	if got := m.Resolve(Env{}).IdleTimeout(); got != 0 {
		t.Errorf("nil minutes: IdleTimeout = %v, want never", got)
	}
	m.IdleUnloadMinutes = ptr(30)
	if got := m.Resolve(Env{}).IdleTimeout(); got != 30*time.Minute {
		t.Errorf("IdleTimeout = %v, want 30m", got)
	}
}

func TestArgsIsACopy(t *testing.T) {
	m := DefaultModels()
	m.Options["m"] = ModelOptions{Args: "-c 4096"}
	r := m.Resolve(Env{})
	got := r.Args("m")
	_ = append(got[:1], "x")
	if again := r.Args("m"); len(again) != 2 || again[1] != "4096" {
		t.Fatalf("Args after a write into the copy = %v", again)
	}
	if r.Args("other") != nil {
		t.Fatal("a model without options has arguments")
	}
}

func TestUseMMProj(t *testing.T) {
	m := DefaultModels()
	m.Options["off"] = ModelOptions{Args: "-c 4096 --no-mmproj"}
	m.Options["on"] = ModelOptions{Args: "-c 4096"}
	r := m.Resolve(Env{})
	for id, want := range map[string]bool{"off": false, "on": true, "unknown": true} {
		if got := r.UseMMProj(id); got != want {
			t.Errorf("UseMMProj(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestOverride(t *testing.T) {
	o := NewOverride()
	calls := 0
	o.OnChange(func() { calls++ })
	if _, ok := o.Get(); ok {
		t.Fatal("Get is set before any Set")
	}

	bad := DefaultModels()
	bad.Engine = "x"
	if err := o.Set(bad); err == nil {
		t.Fatal("an invalid value was accepted")
	}
	if _, ok := o.Get(); ok || calls != 0 {
		t.Fatalf("an invalid Set changed the override (set %v) or notified (%d)", ok, calls)
	}

	good := DefaultModels()
	good.ModelsDir = ptr(t.TempDir())
	if err := o.Set(good); err != nil {
		t.Fatal(err)
	}
	got, ok := o.Get()
	if !ok || got.ModelsDir == nil || *got.ModelsDir != *good.ModelsDir {
		t.Fatalf("Get = %+v, %v", got, ok)
	}
	if calls != 1 {
		t.Fatalf("onChange called %d times, want 1", calls)
	}
}
