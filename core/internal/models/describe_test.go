package models

import (
	"slices"
	"testing"

	"github.com/countingticks/openvatra/core/internal/engine"
)

func TestQuant(t *testing.T) {
	cases := map[string]string{
		"Qwen3-8B-Q4_K_M":                            "Q4_K_M",
		"gemma-3-12b-it-Q4_K_M":                      "Q4_K_M",
		"Qwen3-30B-A3B-UD-Q4_K_XL":                   "UD-Q4_K_XL",
		"Llama-3.2-3B-Instruct-IQ4_XS":               "IQ4_XS",
		"gpt-oss-20b-MXFP4":                          "MXFP4",
		"Qwen3-Coder-30B-A3B-Instruct-UD-IQ2_M":      "UD-IQ2_M",
		"nomic-embed-text-v1.5.f16":                  "F16",
		"Mistral-Small-3.2-24B-Instruct-2506-Q5_K_S": "Q5_K_S",
		"DeepSeek-R1-Distill-Qwen-7B-Q8_0":           "Q8_0",
		"phi-4-BF16":                                 "BF16",
		"Qwen2.5-Coder-7B-Instruct-Q6_K":             "Q6_K",
		"tinyllama-1.1b-chat-v1.0.Q2_K":              "Q2_K",
		"Meta-Llama-3.1-8B-Instruct-Q4_0":            "Q4_0",
		"granite-3.1-8b-instruct-f32":                "F32",
		"Qwen3-235B-A22B-UD-Q2_K_XL":                 "UD-Q2_K_XL",
		"bge-m3-Q8_0":                                "Q8_0",
		"Devstral-Small-2507-IQ3_XXS":                "IQ3_XXS",
		"gemma-3-4b-it-qat-q4_0":                     "Q4_0",
		"llama-2-7b.ggmlv3.q4_1":                     "Q4_1",
		"my-model":                                   "",
	}
	for stem, want := range cases {
		t.Run(stem, func(t *testing.T) {
			if got := Quant(stem); got != want {
				t.Fatalf("Quant(%q) = %q, want %q", stem, got, want)
			}
		})
	}
}

func TestDescribeName(t *testing.T) {
	owned := func(string) (Owner, bool) { return Owner{Name: "Catalog Name"}, true }
	cases := []struct {
		name  string
		m     Model
		owner func(string) (Owner, bool)
		want  string
	}{
		{"owner wins over general.name", Model{ID: "x", GeneralName: "Header"}, owned, "Catalog Name"},
		{"general.name wins over the stem", Model{ID: "x", GeneralName: "Header"}, func(string) (Owner, bool) { return Owner{}, false }, "Header"},
		{"the stem with separators as spaces", Model{ID: "Qwen3-8B_Q4"}, nil, "Qwen3 8B Q4"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Describe([]Model{c.m}, c.owner)[0].Name; got != c.want {
				t.Fatalf("name = %q, want %q", got, c.want)
			}
		})
	}
}

func TestIsCode(t *testing.T) {
	cases := map[string]bool{
		"Qwen2.5-Coder-7B": true,
		"Devstral-Small":   true,
		"code-llama":       true,
		"Qwen3-8B":         false,
		"barcode":          false,
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			if got := IsCode(name); got != want {
				t.Fatalf("IsCode(%q) = %v, want %v", name, got, want)
			}
		})
	}
}

func TestDescribeTags(t *testing.T) {
	moe := engine.Shape{ExpertBytes: 10}
	cases := []struct {
		name  string
		m     Model
		owner func(string) (Owner, bool)
		want  []string
	}{
		{"owner tag code", Model{ID: "x", Kind: KindChat}, func(string) (Owner, bool) { return Owner{Tags: []string{"chat", "code"}}, true }, []string{"Code"}},
		{"coder in the stem", Model{ID: "Qwen2.5-Coder-7B", Kind: KindChat}, nil, []string{"Code"}},
		{"codellama is not code", Model{ID: "codellama", Kind: KindChat}, nil, []string{}},
		{"vision and MoE", Model{ID: "x", Kind: KindChat, MMProj: "p.gguf", Shape: moe}, nil, []string{"Vision", "MoE"}},
		{"embedding", Model{ID: "x", Kind: KindEmbedding}, nil, []string{"Embeddings"}},
		{"all three in order", Model{ID: "devstral", Kind: KindChat, MMProj: "p.gguf", Shape: moe}, nil, []string{"Code", "Vision", "MoE"}},
		{"nothing", Model{ID: "x", Kind: KindChat}, nil, []string{}},
		{"unreadable only gets Code", Model{ID: "my-coder", Kind: KindUnreadable, MMProj: "p.gguf"}, nil, []string{"Code"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Describe([]Model{c.m}, c.owner)[0].Tags
			if got == nil || !slices.Equal(got, c.want) {
				t.Fatalf("tags = %#v, want %#v", got, c.want)
			}
		})
	}
	if got := Describe(nil, nil); len(got) != 0 {
		t.Fatalf("empty list gave %v", got)
	}
}
