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
	if d.Path != nil || d.Build != "bundled" {
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
		{"unknown build", func(s *LlamaServerSettings) { s.Build = "vulkan" }, `build must be "bundled" or "cuda"`},
		{"empty build", func(s *LlamaServerSettings) { s.Build = "" }, `build must be "bundled" or "cuda"`},
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
	ok := LlamaServerSettings{Path: strPtr(abs), Build: "cuda"}
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

func TestSettingsResolve(t *testing.T) {
	llamaDir, enginesDir := t.TempDir(), t.TempDir()
	bundled := filepath.Join(llamaDir, "llama-server.exe")
	cudaExe := filepath.Join(enginesDir, "b1-cuda", "llama-server.exe")
	set := filepath.Join(t.TempDir(), "my-server.exe")
	env := Env{LlamaDir: llamaDir, EnginesDir: enginesDir, Tag: "b1"}
	cuda := LlamaServerSettings{Build: "cuda"}

	if got := cuda.Resolve(env); got != bundled {
		t.Errorf("cuda without the file = %q, want the bundled %q", got, bundled)
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
		{"bundled", DefaultSettings(), env, bundled},
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

func TestSettingsEffectiveReportsTheResolvedPath(t *testing.T) {
	llamaDir := t.TempDir()
	got := Effective(Env{LlamaDir: llamaDir})(DefaultSettings())
	if want := filepath.Join(llamaDir, "llama-server.exe"); got.Path != want {
		t.Fatalf("effective path = %q, want %q", got.Path, want)
	}
}
