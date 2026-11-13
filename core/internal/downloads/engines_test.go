package downloads

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFile creates path and its parents with content.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEnginesBundledTag(t *testing.T) {
	tests := []struct {
		name string
		tag  *string // nil = no .tag file
		want *string
	}{
		{"trailing newline", ptr("b12078\r\n"), ptr("b12078")},
		{"no file", nil, nil},
		{"empty file", ptr(""), nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			if tt.tag != nil {
				writeFile(t, filepath.Join(dir, ".tag"), *tt.tag)
			}
			got := Engines(dir, "", "").Bundled.Tag
			if (got == nil) != (tt.want == nil) || (got != nil && *got != *tt.want) {
				t.Errorf("tag = %v, want %v", deref(got), deref(tt.want))
			}
		})
	}
}

func TestEnginesCuda(t *testing.T) {
	tests := []struct {
		name    string
		files   []string // relative to the engines folder
		missing bool     // the engines folder does not exist
		pinned  string
		want    string
	}{
		{"pinned build installed", []string{"b2-cuda/llama-server.exe"}, false, "b2", cudaReady},
		{"pinned folder without the exe", []string{"b2-cuda/ggml.dll"}, false, "b2", cudaNone},
		{"only an older build", []string{"b1-cuda/llama-server.exe"}, false, "b2", cudaStale},
		{"no engines folder", nil, true, "b2", cudaNone},
		{"no pinned tag and no folders", nil, false, "", cudaNone},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			engines := filepath.Join(dir, "engines")
			if !tt.missing {
				if err := os.Mkdir(engines, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, f := range tt.files {
				writeFile(t, filepath.Join(engines, f), "x")
			}
			if got := Engines(dir, engines, tt.pinned).Cuda; got != tt.want {
				t.Errorf("cuda = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPinnedTag(t *testing.T) {
	dir := t.TempDir()
	valid := filepath.Join(dir, "llama.json")
	writeFile(t, valid, `{"tag":"b12078","cuda":{}}`)
	noTag := filepath.Join(dir, "notag.json")
	writeFile(t, noTag, `{"cuda":{}}`)
	tests := []struct {
		name, path, want string
	}{
		{"valid file", valid, "b12078"},
		{"missing file", filepath.Join(dir, "missing.json"), ""},
		{"no tag", noTag, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PinnedTag(tt.path); got != tt.want {
				t.Errorf("PinnedTag = %q, want %q", got, tt.want)
			}
		})
	}
}

func ptr(s string) *string { return &s }

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
