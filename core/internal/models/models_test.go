package models

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// touch creates empty files (and their folders) under root.
func touch(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, f := range files {
		p := filepath.Join(root, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDiscover(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		want  []Model // paths relative to root, filled in below
	}{
		{"empty folder", nil, nil},
		{"ignores other files", []string{"notes.txt", "a.bin"}, nil},
		{
			"plain files, sorted, any extension case",
			[]string{"b.gguf", "A.GGUF"},
			[]Model{{ID: "A", Path: "A.GGUF"}, {ID: "b", Path: "b.gguf"}},
		},
		{
			"subfolders are searched",
			[]string{"qwen/q.gguf"},
			[]Model{{ID: "q", Path: "qwen/q.gguf"}},
		},
		{
			"split model counts once, via its first part",
			[]string{"big-00002-of-00003.gguf", "big-00001-of-00003.gguf", "big-00003-of-00003.gguf"},
			[]Model{{ID: "big", Path: "big-00001-of-00003.gguf"}},
		},
		{
			"mmproj is attached, not listed",
			[]string{"v/vision.gguf", "v/mmproj-vision-f16.gguf"},
			[]Model{{ID: "vision", Path: "v/vision.gguf", MMProj: "v/mmproj-vision-f16.gguf"}},
		},
		{
			"mmproj in another folder is not attached",
			[]string{"a/m.gguf", "b/mmproj-x.gguf"},
			[]Model{{ID: "m", Path: "a/m.gguf"}},
		},
		{
			"same id twice: first folder wins",
			[]string{"a/m.gguf", "b/m.gguf"},
			[]Model{{ID: "m", Path: "a/m.gguf"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			touch(t, root, tt.files...)

			got, err := Discover(root)
			if err != nil {
				t.Fatal(err)
			}

			var want []Model
			for _, m := range tt.want {
				m.Path = filepath.Join(root, filepath.FromSlash(m.Path))
				if m.MMProj != "" {
					m.MMProj = filepath.Join(root, filepath.FromSlash(m.MMProj))
				}
				want = append(want, m)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %+v, want %+v", got, want)
			}
		})
	}
}

func TestDiscoverWithoutFolder(t *testing.T) {
	for name, root := range map[string]string{
		"not configured": "",
		"does not exist": filepath.Join(t.TempDir(), "missing"),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := Discover(root)
			if err != nil || len(got) != 0 {
				t.Fatalf("got %v, %v; want no models and no error", got, err)
			}
		})
	}
}
