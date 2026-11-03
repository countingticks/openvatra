package models

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
