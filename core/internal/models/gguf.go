package models

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"sync"
	"time"
)

// Kind says what a model file is for.
type Kind string

const (
	KindChat       Kind = "chat"
	KindEmbedding  Kind = "embedding"
	KindUnreadable Kind = "unreadable"
	// KindReranker is only used inside core: rerankers are hidden from the API, so for now they never reach the UI.
	KindReranker Kind = "reranker"
)

// Limits so a broken or hostile file can't make core read forever or allocate gigabytes. Real headers are a few MB
// (the tokenizer's vocabulary is the bulk of it).
const (
	maxHeaderBytes = 64 << 20
	maxStringBytes = 1 << 20
	maxKeyCount    = 100_000
)

// The GGUF value types (the number after each key). Only the string and integer ones are ever read.
const (
	typeUint8   = 0
	typeInt8    = 1
	typeUint16  = 2
	typeInt16   = 3
	typeUint32  = 4
	typeInt32   = 5
	typeFloat32 = 6
	typeBool    = 7
	typeString  = 8
	typeArray   = 9
	typeUint64  = 10
	typeInt64   = 11
	typeFloat64 = 12
)

// Pooling types in llama.cpp's enum: how token vectors become one embedding. 0 is "none" (what chat models have).
const (
	poolingMean = 1
	poolingCLS  = 2
	poolingLast = 3
	poolingRank = 4
)

// encoderArchitectures only ever make embeddings, even if their file lacks a pooling_type.
var encoderArchitectures = map[string]bool{
	"bert": true, "nomic-bert": true, "nomic-bert-moe": true, "jina-bert-v2": true,
	"modern-bert": true, "neo-bert": true, "gemma-embedding": true, "t5encoder": true,
}

// header is the little we need from a GGUF file.
type header struct {
	architecture string
	pooling      map[string]int64 // "<arch>.pooling_type" -> value; the architecture key may come after it
}

// kind applies the rule from the spec.
func (h header) kind() Kind {
	if p, ok := h.pooling[h.architecture+".pooling_type"]; ok {
		switch p {
		case poolingMean, poolingCLS, poolingLast:
			return KindEmbedding
		case poolingRank:
			return KindReranker
		}
	}
	if encoderArchitectures[h.architecture] {
		return KindEmbedding
	}
	return KindChat
}

// ggufReader counts every byte it consumes so the whole read stays under maxHeaderBytes.
type ggufReader struct {
	r   *bufio.Reader
	pos int64
}

var errTooLarge = fmt.Errorf("header is larger than %d MiB", maxHeaderBytes>>20)

func (g *ggufReader) read(p []byte) error {
	if g.pos+int64(len(p)) > maxHeaderBytes {
		return errTooLarge
	}
	n, err := io.ReadFull(g.r, p)
	g.pos += int64(n)
	if err != nil {
		return errors.New("file ends inside the header")
	}
	return nil
}

func (g *ggufReader) skip(n uint64) error {
	if n > uint64(maxHeaderBytes-g.pos) {
		return errTooLarge
	}
	d, err := g.r.Discard(int(n))
	g.pos += int64(d)
	if err != nil {
		return errors.New("file ends inside the header")
	}
	return nil
}

func (g *ggufReader) u32() (uint32, error) {
	var b [4]byte
	err := g.read(b[:])
	return binary.LittleEndian.Uint32(b[:]), err
}

func (g *ggufReader) u64() (uint64, error) {
	var b [8]byte
	err := g.read(b[:])
	return binary.LittleEndian.Uint64(b[:]), err
}

func (g *ggufReader) str() (string, error) {
	n, err := g.u64()
	if err != nil {
		return "", err
	}
	if n > maxStringBytes {
		return "", errors.New("a string in the header is too long")
	}
	b := make([]byte, n)
	if err := g.read(b); err != nil {
		return "", err
	}
	return string(b), nil
}

// fixedSize is the byte size of a non-string, non-array value type, 0 for an unknown type.
func fixedSize(t uint32) uint64 {
	switch t {
	case typeUint8, typeInt8, typeBool:
		return 1
	case typeUint16, typeInt16:
		return 2
	case typeUint32, typeInt32, typeFloat32:
		return 4
	case typeUint64, typeInt64, typeFloat64:
		return 8
	}
	return 0
}

// skipValue moves past a value of type t without keeping it. Arrays (the vocabulary) are skipped element by element
// for strings and in one step for fixed-size elements.
func (g *ggufReader) skipValue(t uint32) error {
	switch {
	case t == typeString:
		n, err := g.u64()
		if err != nil {
			return err
		}
		if n > maxStringBytes {
			return errors.New("a string in the header is too long")
		}
		return g.skip(n)
	case t == typeArray:
		et, err := g.u32()
		if err != nil {
			return err
		}
		count, err := g.u64()
		if err != nil {
			return err
		}
		if et == typeString {
			for i := uint64(0); i < count; i++ {
				if err := g.skipValue(typeString); err != nil {
					return err
				}
			}
			return nil
		}
		size := fixedSize(et)
		if size == 0 {
			return fmt.Errorf("unknown array element type %d", et)
		}
		if count > math.MaxUint64/size {
			return errTooLarge
		}
		return g.skip(count * size)
	case fixedSize(t) != 0:
		return g.skip(fixedSize(t))
	}
	return fmt.Errorf("unknown value type %d", t)
}

// readInt reads an integer value of type t (any width) as int64.
func (g *ggufReader) readInt(t uint32) (int64, bool, error) {
	size := fixedSize(t)
	if t == typeFloat32 || t == typeFloat64 || t == typeBool || size == 0 {
		return 0, false, g.skipValue(t)
	}
	var b [8]byte
	if err := g.read(b[:size]); err != nil {
		return 0, false, err
	}
	u := binary.LittleEndian.Uint64(b[:]) // unused high bytes are zero
	switch t {
	case typeInt8:
		return int64(int8(u)), true, nil
	case typeInt16:
		return int64(int16(u)), true, nil
	case typeInt32:
		return int64(int32(u)), true, nil
	}
	return int64(u), true, nil
}

// readHeader parses the key/value section of a GGUF stream.
func readHeader(r io.Reader) (header, error) {
	g := &ggufReader{r: bufio.NewReaderSize(r, 1<<16)}
	h := header{pooling: map[string]int64{}}

	var magic [4]byte
	if err := g.read(magic[:]); err != nil || string(magic[:]) != "GGUF" {
		return h, errors.New("not a GGUF file")
	}
	version, err := g.u32()
	if err != nil {
		return h, err
	}
	if version != 2 && version != 3 {
		return h, fmt.Errorf("unsupported GGUF version %d", version)
	}
	if _, err := g.u64(); err != nil { // tensor count: not needed
		return h, err
	}
	count, err := g.u64()
	if err != nil {
		return h, err
	}
	if count > maxKeyCount {
		return h, fmt.Errorf("header claims %d keys", count)
	}

	for i := uint64(0); i < count; i++ {
		key, err := g.str()
		if err != nil {
			return h, err
		}
		t, err := g.u32()
		if err != nil {
			return h, err
		}
		switch {
		case key == "general.architecture" && t == typeString:
			if h.architecture, err = g.str(); err != nil {
				return h, err
			}
		case strings.HasSuffix(key, ".pooling_type"):
			v, ok, err := g.readInt(t)
			if err != nil {
				return h, err
			}
			if ok {
				h.pooling[key] = v
			}
		default:
			if err := g.skipValue(t); err != nil {
				return h, err
			}
		}
	}
	if h.architecture == "" {
		return h, errors.New("the file has no general.architecture")
	}
	return h, nil
}

// classify reads one file's header and returns its kind, or KindUnreadable with the reason.
func classify(path string) (Kind, string) {
	f, err := os.Open(path)
	if err != nil {
		return KindUnreadable, "can't open the file"
	}
	defer f.Close()
	h, err := readHeader(f)
	if err != nil {
		return KindUnreadable, err.Error()
	}
	return h.kind(), ""
}

type cacheKey struct {
	path  string
	size  int64
	mtime time.Time
}

type cacheEntry struct {
	kind Kind
	msg  string
}

var (
	cacheMu sync.Mutex
	cache   = map[cacheKey]cacheEntry{}
)

// kindOf is classify with a cache keyed by path, size and modification time, so rescans (every state event runs
// one) don't reread files that haven't changed.
func kindOf(path string) (Kind, string) {
	info, err := os.Stat(path)
	if err != nil {
		return KindUnreadable, "can't open the file"
	}
	key := cacheKey{path, info.Size(), info.ModTime()}
	cacheMu.Lock()
	e, ok := cache[key]
	cacheMu.Unlock()
	if ok {
		return e.kind, e.msg
	}
	k, msg := classify(path)
	cacheMu.Lock()
	cache[key] = cacheEntry{k, msg}
	cacheMu.Unlock()
	return k, msg
}
