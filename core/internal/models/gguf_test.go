package models

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/engine"
)

// kv is one key/value pair of a synthetic header; raw is the value's bytes, typ its GGUF type.
type kv struct {
	key string
	typ uint32
	raw []byte
}

func le32(v uint32) []byte { return binary.LittleEndian.AppendUint32(nil, v) }
func le64(v uint64) []byte { return binary.LittleEndian.AppendUint64(nil, v) }
func gstr(s string) []byte { return append(le64(uint64(len(s))), s...) }

func strKV(k, v string) kv        { return kv{k, typeString, gstr(v)} }
func u32KV(k string, v uint32) kv { return kv{k, typeUint32, le32(v)} }

// buildHeader builds a GGUF header with the given pairs and no tensors.
func buildHeader(version uint32, pairs ...kv) []byte {
	b := append([]byte("GGUF"), le32(version)...)
	b = append(b, le64(0)...)
	b = append(b, le64(uint64(len(pairs)))...)
	for _, p := range pairs {
		b = append(b, gstr(p.key)...)
		b = append(b, le32(p.typ)...)
		b = append(b, p.raw...)
	}
	return b
}

// vocab is a string array like the tokenizer's, to prove arrays are skipped rather than stored.
func vocab(n int) kv {
	raw := append(le32(typeString), le64(uint64(n))...)
	for i := 0; i < n; i++ {
		raw = append(raw, gstr("tok")...)
	}
	return kv{"tokenizer.ggml.tokens", typeArray, raw}
}

func TestKindRule(t *testing.T) {
	tests := []struct {
		name  string
		pairs []kv
		want  Kind
	}{
		{"chat model", []kv{strKV("general.architecture", "llama"), u32KV("llama.block_count", 32)}, KindChat},
		{"last-token pooling", []kv{strKV("general.architecture", "qwen3"), u32KV("qwen3.pooling_type", 3)}, KindEmbedding},
		{"cls pooling", []kv{strKV("general.architecture", "x"), u32KV("x.pooling_type", 2)}, KindEmbedding},
		{"mean pooling", []kv{strKV("general.architecture", "x"), u32KV("x.pooling_type", 1)}, KindEmbedding},
		{"pooling none is chat", []kv{strKV("general.architecture", "llama"), u32KV("llama.pooling_type", 0)}, KindChat},
		{"rank is a reranker", []kv{strKV("general.architecture", "bert"), u32KV("bert.pooling_type", 4)}, KindReranker},
		{"encoder architecture without pooling", []kv{strKV("general.architecture", "nomic-bert")}, KindEmbedding},
		{
			"pooling before the architecture key still counts",
			[]kv{u32KV("qwen3.pooling_type", 3), vocab(5), strKV("general.architecture", "qwen3")},
			KindEmbedding,
		},
		{"another architecture's pooling is ignored", []kv{u32KV("bert.pooling_type", 2), strKV("general.architecture", "llama")}, KindChat},
		{"signed int pooling", []kv{strKV("general.architecture", "x"), {"x.pooling_type", typeInt32, le32(2)}}, KindEmbedding},
		{"skips float, bool and u64 array values", []kv{
			{"a", typeFloat32, le32(0)}, {"b", typeBool, []byte{1}},
			{"c", typeArray, append(append(le32(typeUint64), le64(3)...), make([]byte, 24)...)},
			strKV("general.architecture", "llama"),
		}, KindChat},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, err := readHeader(bytes.NewReader(buildHeader(3, tt.pairs...)))
			if err != nil {
				t.Fatal(err)
			}
			if got := h.kind(); got != tt.want {
				t.Fatalf("kind = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestVersion2IsAccepted(t *testing.T) {
	if _, err := readHeader(bytes.NewReader(buildHeader(2, strKV("general.architecture", "llama")))); err != nil {
		t.Fatal(err)
	}
}

func TestUnreadable(t *testing.T) {
	good := buildHeader(3, strKV("general.architecture", "llama"), vocab(10))
	// The first key claims a string longer than the limit.
	hugeString := append(buildHeader(3)[:24], le64(maxStringBytes+1)...)
	hugeString[16] = 1 // one key
	tooManyKeys := append(buildHeader(3)[:16], le64(maxKeyCount+1)...)
	bigArray := buildHeader(3, kv{"a", typeArray, append(le32(typeUint8), le64(maxHeaderBytes+1)...)})
	hugeCount := buildHeader(3, kv{"a", typeArray, append(le32(typeUint64), le64(1<<62)...)})

	tests := []struct {
		name string
		data []byte
		msg  string
	}{
		{"not gguf", []byte("hello world, definitely not a model"), "not a GGUF file"},
		{"empty", nil, "not a GGUF file"},
		{"unsupported version", buildHeader(7), "unsupported GGUF version"},
		{"big endian version", append([]byte("GGUF"), 0, 0, 0, 3), "unsupported GGUF version"},
		{"truncated", good[:len(good)-5], "ends inside"},
		{"truncated early", good[:10], "ends inside"},
		{"string over limit", hugeString, "too long"},
		{"too many keys", tooManyKeys, "claims"},
		{"array past the read limit", bigArray, "larger than"},
		{"array count overflows", hugeCount, "larger than"},
		{"unknown value type", buildHeader(3, kv{"a", 99, nil}), "unknown value type"},
		{"no architecture", buildHeader(3, u32KV("x", 1)), "general.architecture"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := readHeader(bytes.NewReader(tt.data))
			if err == nil || !strings.Contains(err.Error(), tt.msg) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.msg)
			}
		})
	}
}

func TestKindOfCachesByStatAndRereadsOnChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.gguf")
	write := func(data []byte, mtime time.Time) {
		t.Helper()
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	// "llama" and "bert" differ in length, so pad the second to the first's size: only the cache key is the same.
	chat := buildHeader(3, strKV("general.architecture", "llama"))
	embed := buildHeader(3, strKV("general.architecture", "bert"))
	embed = append(embed, make([]byte, len(chat)-len(embed))...)

	t0 := time.Now().Add(-time.Hour)
	write(chat, t0)
	if k, _ := kindOf(path); k != KindChat {
		t.Fatalf("kind = %q, want chat", k)
	}
	write(embed, t0) // same path, size and mtime: the cache answers, so the file isn't read again
	if k, _ := kindOf(path); k != KindChat {
		t.Fatalf("kind = %q, want the cached chat", k)
	}
	write(embed, t0.Add(time.Minute)) // modified: read again
	if k, _ := kindOf(path); k != KindEmbedding {
		t.Fatalf("kind = %q, want embedding after the file changed", k)
	}
}

func TestDiscoverKindsAndResolve(t *testing.T) {
	root := t.TempDir()
	put := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put("chat.gguf", buildHeader(3, strKV("general.architecture", "llama")))
	put("e1.gguf", buildHeader(3, strKV("general.architecture", "bert")))
	put("e2.gguf", buildHeader(3, strKV("general.architecture", "qwen3"), u32KV("qwen3.pooling_type", 3)))
	put("rank.gguf", buildHeader(3, strKV("general.architecture", "bert"), u32KV("bert.pooling_type", 4)))
	put("junk.gguf", []byte("nope"))

	got, err := Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]Kind{}
	for _, m := range got {
		kinds[m.ID] = m.Kind
		if m.Kind == KindUnreadable && m.Error == "" {
			t.Errorf("%s is unreadable and needs a message", m.ID)
		}
	}
	want := map[string]Kind{"chat": KindChat, "e1": KindEmbedding, "e2": KindEmbedding, "junk": KindUnreadable}
	if len(kinds) != len(want) {
		t.Fatalf("kinds = %v, want %v (the reranker is hidden)", kinds, want)
	}
	for id, k := range want {
		if kinds[id] != k {
			t.Errorf("%s: kind %q, want %q", id, kinds[id], k)
		}
	}

	for chosen, want := range map[string]string{
		"e2":   "e2", // chosen embedding model
		"":     "e1", // Automatic: the first by id
		"chat": "e1", // a chat model is ignored
		"gone": "e1",
		"junk": "e1",
	} {
		if r := ResolveEmbedding(got, chosen); r != want {
			t.Errorf("ResolveEmbedding(%q) = %q, want %q", chosen, r, want)
		}
	}
	if r := ResolveEmbedding([]Model{{ID: "chat", Kind: KindChat}}, ""); r != "" {
		t.Errorf("with only a chat model got %q, want none", r)
	}
}

// tensor is one entry of a synthetic tensor table.
type tensor struct {
	name   string
	dims   []uint64
	offset uint64
}

func arrKV(k string, vals ...uint32) kv {
	raw := append(le32(typeUint32), le64(uint64(len(vals)))...)
	for _, v := range vals {
		raw = append(raw, le32(v)...)
	}
	return kv{k, typeArray, raw}
}

// tableOf writes the tensor table; claimed is the count the header states.
func tableOf(tensors []tensor) []byte {
	var b []byte
	for _, x := range tensors {
		b = append(b, gstr(x.name)...)
		b = append(b, le32(uint32(len(x.dims)))...)
		for _, d := range x.dims {
			b = append(b, le64(d)...)
		}
		b = append(b, le32(0)...) // type
		b = append(b, le64(x.offset)...)
	}
	return b
}

// buildFile builds a whole GGUF file: keys, tensor table, padding to the alignment and dataBytes of zeros.
func buildFile(version uint32, pairs []kv, tensors []tensor, dataBytes int) []byte {
	b := append([]byte("GGUF"), le32(version)...)
	b = append(b, le64(uint64(len(tensors)))...)
	b = append(b, le64(uint64(len(pairs)))...)
	align := 32
	for _, p := range pairs {
		b = append(b, gstr(p.key)...)
		b = append(b, le32(p.typ)...)
		b = append(b, p.raw...)
		if p.key == "general.alignment" {
			align = int(binary.LittleEndian.Uint32(p.raw))
		}
	}
	b = append(b, tableOf(tensors)...)
	b = append(b, make([]byte, (align-len(b)%align)%align)...)
	return append(b, make([]byte, dataBytes)...)
}

func shapeOf(t *testing.T, data []byte) (header, engine.Shape) {
	t.Helper()
	h, err := readHeader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return h, h.shape(int64(len(data)))
}

func denseKeys(extra ...kv) []kv {
	return append([]kv{
		strKV("general.architecture", "llama"), u32KV("llama.context_length", 4096), u32KV("llama.block_count", 32),
		u32KV("llama.attention.head_count", 16), u32KV("llama.attention.head_count_kv", 4),
		u32KV("llama.attention.key_length", 128), u32KV("llama.attention.value_length", 96),
		u32KV("llama.embedding_length", 2048),
	}, extra...)
}

func TestShapeFromHeader(t *testing.T) {
	moeTensors := []tensor{
		{"blk.0.attn_q.weight", []uint64{4, 4}, 0},
		{"blk.0.ffn_up_exps.weight", []uint64{4, 4, 8}, 1000},
		{"blk.1.ffn_up_exps.weight", []uint64{4, 4, 8}, 3000},
	}
	tests := []struct {
		name    string
		pairs   []kv
		tensors []tensor
		data    int
		want    engine.Shape
	}{
		{
			"dense", denseKeys(), []tensor{{"blk.0.attn_q.weight", []uint64{4}, 0}}, 100,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 4, KeyLen: 128, ValueLen: 96},
		},
		{
			"moe: the last expert tensor runs to the end of the file", denseKeys(u32KV("llama.expert_count", 8)), moeTensors, 5000,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 4, KeyLen: 128, ValueLen: 96, ExpertBytes: 2000 + 2000},
		},
		{
			"expert tensors without expert_count", denseKeys(), moeTensors, 5000,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 4, KeyLen: 128, ValueLen: 96},
		},
		{
			"head_count_kv as an array takes the largest", denseKeys(arrKV("llama.attention.head_count_kv", 0, 8, 4)), nil, 0,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 8, KeyLen: 128, ValueLen: 96, AttentionLayers: 2},
		},
		{
			"full_attention_interval divides the layers", denseKeys(u32KV("llama.full_attention_interval", 4)), nil, 0,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 4, KeyLen: 128, ValueLen: 96, AttentionLayers: 8},
		},
		{
			"the array wins over the interval", denseKeys(arrKV("llama.attention.head_count_kv", 0, 8, 4), u32KV("llama.full_attention_interval", 4)), nil, 0,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 8, KeyLen: 128, ValueLen: 96, AttentionLayers: 2},
		},
		{
			"head_count_kv missing falls back to head_count",
			[]kv{strKV("general.architecture", "llama"), u32KV("llama.block_count", 2), u32KV("llama.attention.head_count", 16)}, nil, 0,
			engine.Shape{Layers: 2, KVHeads: 16},
		},
		{
			"key and value length missing fall back to embedding_length / head_count",
			[]kv{
				strKV("general.architecture", "llama"), u32KV("llama.attention.head_count", 16),
				u32KV("llama.embedding_length", 2050), u32KV("llama.attention.head_count_kv", 2),
			}, nil, 0,
			engine.Shape{KVHeads: 2, KeyLen: 128, ValueLen: 128},
		},
		{
			"keys before the architecture still count",
			[]kv{u32KV("llama.block_count", 7), vocab(3), strKV("general.architecture", "llama")}, nil, 0,
			engine.Shape{Layers: 7},
		},
		{
			"alignment 64 shifts the data start",
			denseKeys(u32KV("llama.expert_count", 2), u32KV("general.alignment", 64)),
			[]tensor{{"blk.0.ffn_gate_exps.weight", []uint64{1}, 0}}, 300,
			engine.Shape{MaxContext: 4096, Layers: 32, KVHeads: 4, KeyLen: 128, ValueLen: 96, ExpertBytes: 300},
		},
		{
			"a tensor with 9 dimensions fails the table", denseKeys(u32KV("llama.expert_count", 2)),
			[]tensor{{"blk.0.ffn_gate_exps.weight", make([]uint64, 9), 0}}, 300,
			engine.Shape{MaxContext: 4096, KVHeads: 4, KeyLen: 128, ValueLen: 96},
		},
		{
			"an offset past the end of the file fails the table", denseKeys(u32KV("llama.expert_count", 2)),
			[]tensor{{"blk.0.ffn_gate_exps.weight", []uint64{1}, 1000}}, 300,
			engine.Shape{MaxContext: 4096, KVHeads: 4, KeyLen: 128, ValueLen: 96},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := buildFile(3, tt.pairs, tt.tensors, tt.data)
			h, got := shapeOf(t, data)
			if got != tt.want {
				t.Fatalf("shape = %+v, want %+v", got, tt.want)
			}
			if h.kind() != KindChat {
				t.Fatalf("kind = %q, want chat", h.kind())
			}
		})
	}
}

func TestTensorCountOverLimitFailsTheTableOnly(t *testing.T) {
	data := buildFile(3, denseKeys(u32KV("llama.expert_count", 2)), nil, 0)
	copy(data[8:16], le64(maxTensorCount+1)) // claim a million and one tensors; none follow
	h, got := shapeOf(t, data)
	if got.Layers != 0 || got.ExpertBytes != 0 || got.KVHeads != 4 || h.kind() != KindChat {
		t.Fatalf("shape = %+v kind %q, want the keys kept, Layers and ExpertBytes 0, chat", got, h.kind())
	}
	if cap(h.tensors) != 0 {
		t.Fatalf("allocated room for %d tensors", cap(h.tensors))
	}
}

func TestKindOfCachesTheShape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.gguf")
	a := buildFile(3, denseKeys(), nil, 8)
	b := buildFile(3, append(denseKeys()[:2:2], denseKeys()[3:]...), nil, 8) // another shape, other length
	b = append(b, make([]byte, len(a)-len(b))...)
	if len(b) != len(a) {
		t.Fatalf("test setup: %d != %d", len(a), len(b))
	}
	t0 := time.Now().Add(-time.Hour)
	write := func(data []byte, mtime time.Time) {
		t.Helper()
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	write(a, t0)
	if l := inspect(path, true).shape.Layers; l != 32 {
		t.Fatalf("Layers = %d, want 32", l)
	}
	write(b, t0)
	if l := inspect(path, true).shape.Layers; l != 32 {
		t.Fatalf("Layers = %d, want the cached 32", l)
	}
	write(b, t0.Add(time.Minute))
	if l := inspect(path, true).shape.Layers; l != 0 {
		t.Fatalf("Layers = %d, want 0 after the file changed", l)
	}
}
