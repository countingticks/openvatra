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
			"a <model>-mmproj file is attached, not listed",
			[]string{"v/qwen-7b-q4_K_M.gguf", "v/qwen-7b-mmproj.gguf"},
			[]Model{{ID: "qwen-7b-q4_K_M", Path: "v/qwen-7b-q4_K_M.gguf", MMProj: "v/qwen-7b-mmproj.gguf"}},
		},
		{
			"each model gets its own projector from a shared folder",
			[]string{"v/gemma-26b.gguf", "v/gemma-26b-mmproj.gguf", "v/mmproj-qwen-7b-f16.gguf", "v/qwen-7b-q4.gguf"},
			[]Model{
				{ID: "gemma-26b", Path: "v/gemma-26b.gguf", MMProj: "v/gemma-26b-mmproj.gguf"},
				{ID: "qwen-7b-q4", Path: "v/qwen-7b-q4.gguf", MMProj: "v/mmproj-qwen-7b-f16.gguf"},
			},
		},
		{
			"a model without its own projector gets none, not a neighbour's",
			[]string{"v/gemma-12b.gguf", "v/gemma-12b-mmproj.gguf", "v/qwen3-8b-q4.gguf"},
			[]Model{
				{ID: "gemma-12b", Path: "v/gemma-12b.gguf", MMProj: "v/gemma-12b-mmproj.gguf"},
				{ID: "qwen3-8b-q4", Path: "v/qwen3-8b-q4.gguf"},
			},
		},
		{
			"similar names: the projector goes to the closer model only",
			[]string{"v/qwen3.6-35b.gguf", "v/qwen3.8-27b.gguf", "v/qwen3.8-27b-mmproj.gguf"},
			[]Model{
				{ID: "qwen3.6-35b", Path: "v/qwen3.6-35b.gguf"},
				{ID: "qwen3.8-27b", Path: "v/qwen3.8-27b.gguf", MMProj: "v/qwen3.8-27b-mmproj.gguf"},
			},
		},
		{
			"a generic projector is used when the folder has one model",
			[]string{"v/vision-q4.gguf", "v/mmproj-F16.gguf"},
			[]Model{{ID: "vision-q4", Path: "v/vision-q4.gguf", MMProj: "v/mmproj-F16.gguf"}},
		},
		{
			"a generic projector is not guessed among several models",
			[]string{"v/a.gguf", "v/b.gguf", "v/mmproj-F16.gguf"},
			[]Model{{ID: "a", Path: "v/a.gguf"}, {ID: "b", Path: "v/b.gguf"}},
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

			// The files are empty, so every kind is "unreadable"; kinds have their own tests (gguf_test.go), and so
			// do parts (TestDiscoverParts).
			for i := range got {
				got[i].Kind, got[i].Error, got[i].Parts = "", "", nil
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

func TestDiscoverParts(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		want  map[string][]string // id -> parts, relative to root
	}{
		{"a single file is its only part", []string{"a.gguf"}, map[string][]string{"a": {"a.gguf"}}},
		{
			"split parts first to last, whatever order they are written in",
			[]string{"big-00003-of-00003.gguf", "big-00002-of-00003.gguf", "big-00001-of-00003.gguf"},
			map[string][]string{"big": {"big-00001-of-00003.gguf", "big-00002-of-00003.gguf", "big-00003-of-00003.gguf"}},
		},
		{
			"a projector is not a part",
			[]string{"v/vision.gguf", "v/mmproj-vision-f16.gguf"},
			map[string][]string{"vision": {"v/vision.gguf"}},
		},
		{
			"a same-named model in another folder adds no parts",
			[]string{"a/m-00001-of-00002.gguf", "a/m-00002-of-00002.gguf", "b/m-00001-of-00002.gguf", "b/m-00002-of-00002.gguf"},
			map[string][]string{"m": {"a/m-00001-of-00002.gguf", "a/m-00002-of-00002.gguf"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			// Write in the listed order so the reverse-order case really lands that way on disk.
			for _, f := range tt.files {
				touch(t, root, f)
			}
			got, err := Discover(root)
			if err != nil {
				t.Fatal(err)
			}
			parts := map[string][]string{}
			for _, m := range got {
				parts[m.ID] = m.Parts
			}
			want := map[string][]string{}
			for id, ps := range tt.want {
				for _, p := range ps {
					want[id] = append(want[id], filepath.Join(root, filepath.FromSlash(p)))
				}
			}
			if !reflect.DeepEqual(parts, want) {
				t.Fatalf("parts = %v, want %v", parts, want)
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

func TestDiscoverSizes(t *testing.T) {
	root := t.TempDir()
	write := func(name string, size int) {
		if err := os.WriteFile(filepath.Join(root, name), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("small.gguf", 3)
	write("big-00001-of-00002.gguf", 5)
	write("big-00002-of-00002.gguf", 7)

	got, err := Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	sizes := map[string]int64{}
	for _, m := range got {
		sizes[m.ID] = m.SizeBytes
	}
	if want := map[string]int64{"big": 12, "small": 3}; !reflect.DeepEqual(sizes, want) {
		t.Fatalf("sizes = %v, want %v (a split model counts all its parts)", sizes, want)
	}
}

func TestDiscoverShapeSizes(t *testing.T) {
	root := t.TempDir()
	put := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data := buildFile(3, denseKeys(), nil, 100)
	put("v.gguf", data)
	put("v-mmproj.gguf", make([]byte, 77))

	got, err := Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Shape.FileBytes != int64(len(data)) || got[0].Shape.FileBytes != got[0].SizeBytes ||
		got[0].Shape.ProjectorBytes != 77 {
		t.Fatalf("got %+v, want FileBytes = SizeBytes = %d and ProjectorBytes 77", got, len(data))
	}
}

func TestDiscoverSplitMoE(t *testing.T) {
	keys := denseKeys(u32KV("llama.expert_count", 8))
	// Later parts carry no keys at all, not even the architecture.
	part := func(n int, tensors []tensor, data int) []byte {
		if n == 1 {
			return buildFile(3, keys, tensors, data)
		}
		return buildFile(3, nil, tensors, data)
	}
	exps := func(name string) []tensor { return []tensor{{name, []uint64{1}, 0}} }

	tests := []struct {
		name        string
		skipPart2   bool
		wantExperts int64
		wantLayers  int
	}{
		{"all parts present", false, 100 + 200 + 300, 32},
		{"part 2 missing", true, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			put := func(name string, data []byte) {
				if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			put("big-00001-of-00003.gguf", part(1, exps("blk.0.ffn_up_exps.weight"), 100))
			if !tt.skipPart2 {
				put("big-00002-of-00003.gguf", part(2, exps("blk.1.ffn_up_exps.weight"), 200))
			}
			put("big-00003-of-00003.gguf", part(3, exps("blk.2.ffn_up_exps.weight"), 300))

			got, err := Discover(root)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != 1 {
				t.Fatalf("got %d models, want 1", len(got))
			}
			if s := got[0].Shape; s.ExpertBytes != tt.wantExperts || s.Layers != tt.wantLayers {
				t.Fatalf("shape = %+v, want ExpertBytes %d and Layers %d", s, tt.wantExperts, tt.wantLayers)
			}
		})
	}
}
