package llamaserver

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func strPtr(s string) *string { return &s }

func TestDefaultSettings(t *testing.T) {
	d := DefaultSettings()
	if err := d.Validate(); err != nil {
		t.Fatalf("defaults do not validate: %v", err)
	}
	if d.Path != nil || d.Build != "auto" {
		t.Fatalf("defaults = %+v", d)
	}
}

func TestSettingsValidateNamesTheField(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "x")
	cases := []struct {
		name   string
		change func(*LlamaServerSettings)
		field  string
	}{
		{"empty path", func(s *LlamaServerSettings) { s.Path = strPtr("") }, "path must be an absolute path"},
		{"relative path", func(s *LlamaServerSettings) { s.Path = strPtr(`bin\llama-server.exe`) }, "path must be an absolute path"},
		{"NUL in path", func(s *LlamaServerSettings) { s.Path = strPtr(abs + "\x00") }, "path must be an absolute path"},
		{"unknown build", func(s *LlamaServerSettings) { s.Build = "vulkan" }, `build must be "auto", "bundled" or "cuda"`},
		{"empty build", func(s *LlamaServerSettings) { s.Build = "" }, `build must be "auto", "bundled" or "cuda"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := DefaultSettings()
			tc.change(&s)
			if err := s.Validate(); err == nil || !strings.HasPrefix(err.Error(), tc.field) {
				t.Fatalf("err = %v, want %q", err, tc.field)
			}
		})
	}
	for _, build := range []string{"auto", "bundled", "cuda"} {
		ok := LlamaServerSettings{Path: strPtr(abs), Build: build}
		if err := ok.Validate(); err != nil {
			t.Fatalf("%s is valid but was rejected: %v", build, err)
		}
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

func TestSettingsResolve(t *testing.T) {
	llamaDir, enginesDir := t.TempDir(), t.TempDir()
	bundled := filepath.Join(llamaDir, "llama-server.exe")
	cudaExe := filepath.Join(enginesDir, "b1-cuda", "llama-server.exe")
	set := filepath.Join(t.TempDir(), "my-server.exe")
	env := Env{LlamaDir: llamaDir, EnginesDir: enginesDir, Tag: "b1"}
	cuda := LlamaServerSettings{Build: "cuda"}
	auto := LlamaServerSettings{Build: "auto"}
	bundledBuild := LlamaServerSettings{Build: "bundled"}
	withNVIDIA := func(yes bool) Env {
		e := env
		e.NVIDIA = func() bool { return yes }
		return e
	}

	if got := cuda.Resolve(env); got != bundled {
		t.Errorf("cuda without the file = %q, want the bundled %q", got, bundled)
	}
	if got := auto.Resolve(withNVIDIA(true)); got != bundled {
		t.Errorf("auto on NVIDIA without the file = %q, want the bundled %q", got, bundled)
	}
	writeFile(t, cudaExe)
	cases := []struct {
		name string
		s    LlamaServerSettings
		env  Env
		want string
	}{
		{"set path wins over cuda", LlamaServerSettings{Path: &set, Build: "cuda"}, env, set},
		{"cuda present", cuda, env, cudaExe},
		{"cuda for another tag", cuda, Env{LlamaDir: llamaDir, EnginesDir: enginesDir, Tag: "b2"}, bundled},
		{"cuda without a tag", cuda, Env{LlamaDir: llamaDir, EnginesDir: enginesDir}, bundled},
		{"auto on NVIDIA with the file", auto, withNVIDIA(true), cudaExe},
		{"auto not on NVIDIA", auto, withNVIDIA(false), bundled},
		{"auto without an NVIDIA answer", auto, env, bundled},
		{"bundled on NVIDIA with the file", bundledBuild, withNVIDIA(true), bundled},
		{"own path wins over auto", LlamaServerSettings{Path: &set, Build: "auto"}, withNVIDIA(true), set},
		{"default", DefaultSettings(), env, bundled},
		{"nothing known", DefaultSettings(), Env{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.s.Resolve(tc.env); got != tc.want {
				t.Fatalf("Resolve = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSettingsResolveProbesHardwareOnlyForAuto(t *testing.T) {
	enginesDir := t.TempDir()
	writeFile(t, filepath.Join(enginesDir, "b1-cuda", "llama-server.exe"))
	own := filepath.Join(t.TempDir(), "my-server.exe")
	for _, tc := range []struct {
		name string
		s    LlamaServerSettings
		want int
	}{
		{"bundled", LlamaServerSettings{Build: "bundled"}, 0},
		{"cuda", LlamaServerSettings{Build: "cuda"}, 0},
		{"own path", LlamaServerSettings{Path: &own, Build: "auto"}, 0},
		{"auto", LlamaServerSettings{Build: "auto"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			env := Env{EnginesDir: enginesDir, Tag: "b1", NVIDIA: func() bool { calls++; return true }}
			tc.s.Resolve(env)
			if calls != tc.want {
				t.Fatalf("NVIDIA called %d times, want %d", calls, tc.want)
			}
		})
	}
}

func TestSettingsEffectiveReportsTheResolvedPath(t *testing.T) {
	llamaDir := t.TempDir()
	got := Effective(Env{LlamaDir: llamaDir})(DefaultSettings())
	if want := filepath.Join(llamaDir, "llama-server.exe"); got.Path != want {
		t.Fatalf("effective path = %q, want %q", got.Path, want)
	}
}
