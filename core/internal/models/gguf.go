package models

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/countingticks/openvatra/core/internal/engine"
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
	maxTensorCount = 1_000_000
	maxTensorDims  = 8
	// defaultAlignment is where tensor data starts when the file has no general.alignment.
	defaultAlignment = 32
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

// shapeSuffixes are the "<arch>." keys the shape is read from; the architecture key may come after them, so they
// are kept by full key and looked up at the end, like pooling_type.
var shapeSuffixes = []string{
	".context_length", ".block_count", ".embedding_length", ".expert_count",
	".attention.head_count", ".attention.head_count_kv", ".attention.key_length", ".attention.value_length",
	".full_attention_interval",
}

func isShapeKey(key string) bool {
	for _, s := range shapeSuffixes {
		if strings.HasSuffix(key, s) {
			return true
		}
	}
	return key == "general.alignment"
}

// tensorRef is what the tensor table is kept for: where a tensor starts and whether it holds expert weights.
type tensorRef struct {
	offset uint64
	expert bool
}

// attentionLayersSuffix marks, in header.ints, how many entries of a head_count_kv array are positive: the layers
// that keep a KV cache.
const attentionLayersSuffix = "#positive"

// header is the little we need from a GGUF file.
type header struct {
	architecture string
	pooling      map[string]int64 // "<arch>.pooling_type" -> value; the architecture key may come after it
	ints         map[string]int64 // shape keys by full key; head_count_kv holds the largest of an array

	// The tensor table. A table that fails to read leaves tableOK false and the keys intact.
	tableOK   bool
	dataStart int64
	tensors   []tensorRef
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

// readHeader parses the key/value section and the tensor table of a GGUF stream.
func readHeader(r io.Reader) (header, error) { return parseHeader(r, true) }

// readArrayMax reads an array and returns its largest integer and how many entries are positive.
func (g *ggufReader) readArrayMax() (best int64, positive int, found bool, err error) {
	et, err := g.u32()
	if err != nil {
		return 0, 0, false, err
	}
	count, err := g.u64()
	if err != nil {
		return 0, 0, false, err
	}
	for i := uint64(0); i < count; i++ {
		v, ok, err := g.readInt(et)
		if err != nil {
			return 0, 0, false, err
		}
		if ok && (!found || v > best) {
			best, found = v, true
		}
		if ok && v > 0 {
			positive++
		}
	}
	return best, positive, found, nil
}

// readTable reads the tensor table that follows the keys. Any failure is the table's alone.
func (g *ggufReader) readTable(count uint64, h *header) error {
	if count > maxTensorCount {
		return fmt.Errorf("header claims %d tensors", count)
	}
	var refs []tensorRef // grown as tensors are read: a lying count allocates nothing
	for i := uint64(0); i < count; i++ {
		name, err := g.str()
		if err != nil {
			return err
		}
		dims, err := g.u32()
		if err != nil {
			return err
		}
		if dims > maxTensorDims {
			return fmt.Errorf("a tensor has %d dimensions", dims)
		}
		if err := g.skip(uint64(dims) * 8); err != nil {
			return err
		}
		if _, err := g.u32(); err != nil { // the type: sizes come from the offsets
			return err
		}
		off, err := g.u64()
		if err != nil {
			return err
		}
		refs = append(refs, tensorRef{off, strings.Contains(name, "_exps")})
	}
	h.tensors = refs
	align := h.ints["general.alignment"]
	if align <= 0 {
		align = defaultAlignment
	}
	h.dataStart = (g.pos + align - 1) / align * align
	return nil
}

// parseHeader is readHeader; requireArch is false for the later parts of a split model, which may carry no
// general.architecture.
func parseHeader(r io.Reader, requireArch bool) (header, error) {
	g := &ggufReader{r: bufio.NewReaderSize(r, 1<<16)}
	h := header{pooling: map[string]int64{}, ints: map[string]int64{}}

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
	tensorCount, err := g.u64()
	if err != nil {
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
		case isShapeKey(key) && t == typeArray:
			if !strings.HasSuffix(key, ".attention.head_count_kv") {
				if err := g.skipValue(t); err != nil {
					return h, err
				}
				break
			}
			v, positive, ok, err := g.readArrayMax()
			if err != nil {
				return h, err
			}
			if ok {
				h.ints[key] = v
				h.ints[key+attentionLayersSuffix] = int64(positive)
			}
		case isShapeKey(key):
			v, ok, err := g.readInt(t)
			if err != nil {
				return h, err
			}
			if ok {
				h.ints[key] = v
			}
		default:
			if err := g.skipValue(t); err != nil {
				return h, err
			}
		}
	}
	h.tableOK = g.readTable(tensorCount, &h) == nil
	if !h.tableOK {
		h.tensors = nil
	}
	if requireArch && h.architecture == "" {
		return h, errors.New("the file has no general.architecture")
	}
	return h, nil
}

// expertBytes sums the sizes of the expert tensors in a file of fileSize bytes. Each tensor runs to the next one's
// offset, the last to the end of the file. false when the table failed or a size comes out negative.
func (h header) expertBytes(fileSize int64) (int64, bool) {
	if !h.tableOK {
		return 0, false
	}
	t := append([]tensorRef(nil), h.tensors...)
	sort.Slice(t, func(i, j int) bool { return t[i].offset < t[j].offset })
	var sum int64
	for i, x := range t {
		next := fileSize - h.dataStart
		if i+1 < len(t) {
			if t[i+1].offset > math.MaxInt64 {
				return 0, false
			}
			next = int64(t[i+1].offset)
		}
		if x.offset > math.MaxInt64 || next < int64(x.offset) {
			return 0, false
		}
		if x.expert {
			sum += next - int64(x.offset)
		}
	}
	return sum, true
}

// shape is what the keys and the tensor table say about a file of fileSize bytes; FileBytes and ProjectorBytes are
// the caller's. A table that failed leaves Layers and ExpertBytes 0, so the estimate is unknown.
func (h header) shape(fileSize int64) engine.Shape {
	get := func(suffix string) (int, bool) {
		v, ok := h.ints[h.architecture+suffix]
		return int(max(v, 0)), ok
	}
	var s engine.Shape
	var ok bool
	s.MaxContext, _ = get(".context_length")
	s.Layers, _ = get(".block_count")
	headCount, _ := get(".attention.head_count")
	if s.KVHeads, ok = get(".attention.head_count_kv"); !ok {
		s.KVHeads = headCount
	}
	// Layers that keep a KV cache: the array's positive entries win over the interval (hybrid models).
	if n, ok := get(".attention.head_count_kv" + attentionLayersSuffix); ok {
		s.AttentionLayers = n
	} else if k, _ := get(".full_attention_interval"); k > 0 {
		s.AttentionLayers = s.Layers / k
	}
	embedding, _ := get(".embedding_length")
	fallback := 0
	if headCount > 0 {
		fallback = embedding / headCount
	}
	if s.KeyLen, ok = get(".attention.key_length"); !ok {
		s.KeyLen = fallback
	}
	if s.ValueLen, ok = get(".attention.value_length"); !ok {
		s.ValueLen = fallback
	}
	experts, _ := get(".expert_count")
	bytes, tableOK := h.expertBytes(fileSize)
	switch {
	case !tableOK:
		s.Layers = 0
	case experts > 0: // decision 3: MoE means the key and the tensors
		s.ExpertBytes = bytes
	}
	return s
}

// fileInfo is what one read of a file's header gives.
type fileInfo struct {
	kind  Kind
	msg   string
	shape engine.Shape
	// rawExperts is the size of the expert tensors whatever expert_count says: the later parts of a split model
	// carry no keys. tableOK says the tensor table read.
	rawExperts int64
	tableOK    bool
	moe        bool // expert_count > 0
}

// classify reads one file's header and returns its kind and shape, or KindUnreadable with the reason.
func classify(path string, size int64, requireArch bool) fileInfo {
	f, err := os.Open(path)
	if err != nil {
		return fileInfo{kind: KindUnreadable, msg: "can't open the file"}
	}
	defer f.Close()
	h, err := parseHeader(f, requireArch)
	if err != nil {
		return fileInfo{kind: KindUnreadable, msg: err.Error()}
	}
	raw, ok := h.expertBytes(size)
	return fileInfo{kind: h.kind(), shape: h.shape(size), rawExperts: raw, tableOK: ok, moe: h.ints[h.architecture+".expert_count"] > 0}
}

type cacheKey struct {
	path  string
	size  int64
	mtime time.Time
}

var (
	cacheMu sync.Mutex
	cache   = map[cacheKey]fileInfo{}
)

// inspect is classify with a cache keyed by path, size and modification time, so rescans (every state event runs
// one) don't reread files that haven't changed.
func inspect(path string, requireArch bool) fileInfo {
	info, err := os.Stat(path)
	if err != nil {
		return fileInfo{kind: KindUnreadable, msg: "can't open the file"}
	}
	key := cacheKey{path, info.Size(), info.ModTime()}
	cacheMu.Lock()
	e, ok := cache[key]
	cacheMu.Unlock()
	if ok {
		return e
	}
	e = classify(path, info.Size(), requireArch)
	cacheMu.Lock()
	cache[key] = e
	cacheMu.Unlock()
	return e
}

// kindOf is the kind of one model file, with the reason when it is unreadable.
func kindOf(path string) (Kind, string) {
	i := inspect(path, true)
	return i.kind, i.msg
}
