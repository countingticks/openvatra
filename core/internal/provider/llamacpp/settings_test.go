package llamacpp

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func settingsPtr[T any](v T) *T { return &v }

func TestDefaultSettings(t *testing.T) {
	d := DefaultSettings()
	if err := d.Validate(); err != nil {
		t.Fatalf("defaults do not validate: %v", err)
	}
	if d.ModelsDir != nil || d.EmbeddingModel != nil {
		t.Errorf("modelsDir and embedding = %v %v, want nil", d.ModelsDir, d.EmbeddingModel)
	}
	if d.IdleUnloadMinutes == nil || *d.IdleUnloadMinutes != 15 {
		t.Errorf("idleUnloadMinutes = %v, want 15", d.IdleUnloadMinutes)
	}
	if d.Options == nil || len(d.Options) != 0 {
		t.Errorf("options = %v, want {}", d.Options)
	}
}

func TestSettingsValidateNamesTheField(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "x")
	cases := []struct {
		name   string
		change func(*LlamaCppSettings)
		field  string
	}{
		{"empty modelsDir", func(s *LlamaCppSettings) { s.ModelsDir = settingsPtr("") }, "modelsDir must be an absolute path"},
		{"relative modelsDir", func(s *LlamaCppSettings) { s.ModelsDir = settingsPtr("Models") }, "modelsDir must be an absolute path"},
		{"NUL in modelsDir", func(s *LlamaCppSettings) { s.ModelsDir = settingsPtr(abs + "\x00") }, "modelsDir must be an absolute path"},
		{"empty embeddingModel", func(s *LlamaCppSettings) { s.EmbeddingModel = settingsPtr("") }, "embeddingModel must not be empty"},
		{"idle 0", func(s *LlamaCppSettings) { s.IdleUnloadMinutes = settingsPtr(0) }, "idleUnloadMinutes must be between 1 and 1440"},
		{"idle 1441", func(s *LlamaCppSettings) { s.IdleUnloadMinutes = settingsPtr(1441) }, "idleUnloadMinutes must be between 1 and 1440"},
		{"nil options", func(s *LlamaCppSettings) { s.Options = nil }, "options must be an object"},
		{"empty model id", func(s *LlamaCppSettings) { s.Options = map[string]ModelOptions{"": {}} }, "options has an empty model id"},
		{"NUL in args", func(s *LlamaCppSettings) { s.Options = map[string]ModelOptions{"m": {Args: "a\x00b"}} }, `options for "m": args must not contain a NUL character`},
		{"reserved flag", func(s *LlamaCppSettings) { s.Options = map[string]ModelOptions{"m": {Args: "--port 1"}} }, `options for "m": --port`},
		{"open quote", func(s *LlamaCppSettings) { s.Options = map[string]ModelOptions{"m": {Args: `"-c`}} }, `options for "m": A quote`},
		{"first field wins", func(s *LlamaCppSettings) {
			s.ModelsDir, s.IdleUnloadMinutes = settingsPtr("Models"), settingsPtr(0)
		}, "modelsDir"},
		{"empty id before bad args", func(s *LlamaCppSettings) {
			s.Options = map[string]ModelOptions{"a": {Args: "--port 1"}, "": {}}
		}, "options has an empty model id"},
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

	ok := DefaultSettings()
	ok.ModelsDir, ok.EmbeddingModel, ok.IdleUnloadMinutes = settingsPtr(abs), settingsPtr("nomic"), nil
	ok.Options["m"] = ModelOptions{Args: `-c 8192 --no-mmproj --chat-template-file "C:\my templates\t.jinja"`}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid value rejected: %v", err)
	}
}

func TestSettingsValidateReportsTheSameOptionEveryTime(t *testing.T) {
	s := DefaultSettings()
	for _, id := range []string{"d", "b", "a", "c"} {
		s.Options[id] = ModelOptions{Args: "--port 1"}
	}
	for range 20 {
		if err := s.Validate(); err == nil || !strings.HasPrefix(err.Error(), `options for "a"`) {
			t.Fatalf("err = %v, want the first id in order", err)
		}
	}
}

func TestSettingsResolveModelsDir(t *testing.T) {
	home := t.TempDir()
	if got, want := DefaultSettings().Resolve(home).ModelsDir, filepath.Join(home, "OpenVatra", "Models"); got != want {
		t.Errorf("default ModelsDir = %q, want %q", got, want)
	}
	if got := DefaultSettings().Resolve("").ModelsDir; got != "" {
		t.Errorf("without a home ModelsDir = %q, want empty", got)
	}
	set := DefaultSettings()
	set.ModelsDir = settingsPtr(filepath.Join(home, "elsewhere"))
	if got := set.Resolve(home).ModelsDir; got != *set.ModelsDir {
		t.Errorf("set ModelsDir = %q, want %q", got, *set.ModelsDir)
	}
	if got := Effective(home)(set).ModelsDir; got != *set.ModelsDir {
		t.Errorf("effective ModelsDir = %q, want %q", got, *set.ModelsDir)
	}
}

func TestSettingsIdleTimeout(t *testing.T) {
	s := DefaultSettings()
	s.IdleUnloadMinutes = nil
	if got := s.Resolve("").IdleTimeout(); got != 0 {
		t.Errorf("nil minutes: IdleTimeout = %v, want never", got)
	}
	s.IdleUnloadMinutes = settingsPtr(30)
	if got := s.Resolve("").IdleTimeout(); got != 30*time.Minute {
		t.Errorf("IdleTimeout = %v, want 30m", got)
	}
}

func TestSettingsArgsIsACopy(t *testing.T) {
	s := DefaultSettings()
	s.Options["m"] = ModelOptions{Args: "-c 4096"}
	r := s.Resolve("")
	got := r.Args("m")
	_ = append(got[:1], "x")
	if again := r.Args("m"); len(again) != 2 || again[1] != "4096" {
		t.Fatalf("Args after a write into the copy = %v", again)
	}
	if r.Args("other") != nil {
		t.Fatal("a model without options has arguments")
	}
}

func TestSettingsUseMMProj(t *testing.T) {
	s := DefaultSettings()
	s.Options["off"] = ModelOptions{Args: "-c 4096 --no-mmproj"}
	s.Options["on"] = ModelOptions{Args: "-c 4096"}
	r := s.Resolve("")
	for id, want := range map[string]bool{"off": false, "on": true, "unknown": true} {
		if got := r.UseMMProj(id); got != want {
			t.Errorf("UseMMProj(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestSettingsOptionWithoutArgs(t *testing.T) {
	s := DefaultSettings()
	s.Options["m"] = ModelOptions{}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"options":{"m":{}}`) {
		t.Errorf("written as %s, want the option as {}", data)
	}
	var stored LlamaCppSettings
	if err := json.Unmarshal([]byte(`{"options":{"m":{"args":""}}}`), &stored); err != nil {
		t.Fatal(err)
	}
	if args := stored.Resolve("").Args("m"); args != nil {
		t.Errorf(`{"args": ""} reads as arguments %v`, args)
	}
}

func TestSettingsValidateContextAndPlacement(t *testing.T) {
	cases := []struct {
		name string
		opt  ModelOptions
		want string // "" = valid
	}{
		{"context 2047", ModelOptions{Context: settingsPtr(2047)}, `options for "m": context must be between 2048 and 1048576`},
		{"context 1048577", ModelOptions{Context: settingsPtr(1048577)}, `options for "m": context must be between 2048 and 1048576`},
		{"context 2048", ModelOptions{Context: settingsPtr(2048)}, ""},
		{"context 1048576", ModelOptions{Context: settingsPtr(1048576)}, ""},
		{"placement middle", ModelOptions{Placement: "middle"}, `options for "m": placement must be auto, gpu, experts, layers or cpu`},
		{"placement auto", ModelOptions{Placement: "auto"}, ""},
		{"placement gpu", ModelOptions{Placement: "gpu"}, ""},
		{"placement experts", ModelOptions{Placement: "experts"}, ""},
		{"placement layers", ModelOptions{Placement: "layers"}, ""},
		{"placement cpu", ModelOptions{Placement: "cpu"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := DefaultSettings()
			s.Options["m"] = tc.opt
			err := s.Validate()
			if tc.want == "" && err != nil {
				t.Fatalf("valid value rejected: %v", err)
			}
			if tc.want != "" && (err == nil || err.Error() != tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestSettingsSize(t *testing.T) {
	s := DefaultSettings()
	s.Options["plain"] = ModelOptions{Args: "--jinja"}
	s.Options["set"] = ModelOptions{Context: settingsPtr(4096), Placement: "cpu"}
	r := s.Resolve("")
	for id, want := range map[string]struct {
		context   int
		placement string
	}{"plain": {0, "auto"}, "unknown": {0, "auto"}, "set": {4096, "cpu"}} {
		if c, p := r.Size(id); c != want.context || p != want.placement {
			t.Errorf("Size(%q) = %d %q, want %d %q", id, c, p, want.context, want.placement)
		}
	}
}

func TestSettingsNullContextIsAuto(t *testing.T) {
	var s LlamaCppSettings
	if err := json.Unmarshal([]byte(`{"options":{"m":{"context":null}}}`), &s); err != nil {
		t.Fatal(err)
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("null context rejected: %v", err)
	}
	if c, p := s.Resolve("").Size("m"); c != 0 || p != "auto" {
		t.Errorf("Size = %d %q, want 0 auto", c, p)
	}
}
