// Package models finds the chat and embedding models on disk.
package models

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/countingticks/openvatra/core/internal/engine"
)

// Model is one model the user can load.
type Model struct {
	// ID is the file name without ".gguf" (for split models, without the part suffix).
	ID string
	// Path is the file to hand to llama-server; for split models the first part,
	// because llama.cpp finds the remaining parts itself.
	Path string
	// Parts are every file of the model, the first part (Path) first, then the others in part order; one element for
	// a model in a single file. Projectors are not parts.
	Parts []string
	// MMProj is the vision projector file in the same folder, or "" if there is none. With several projectors in
	// one folder, the one whose name shares the longest start with the model's (qwen-7b-q4 → qwen-7b-mmproj).
	MMProj string
	// SizeBytes is the size on disk; for split models, all parts together.
	SizeBytes int64
	// Kind comes from the GGUF header (chat, embedding or unreadable); Error says why when it is unreadable.
	Kind  Kind
	Error string
	// Shape is what the header says about the model's size and layout (zero fields are unknown); callers ignore it
	// for embedding and unreadable models.
	Shape engine.Shape
	// GeneralName is the header's general.name, trimmed; "" when absent or unreadable.
	GeneralName string
	// Name, Quant and Tags are set by Describe.
	Name  string
	Quant string // "" = unknown
	Tags  []string
}

// ResolveEmbedding returns the id of the embedding model that serves: the chosen one if it exists and is an
// embedding model, else the first embedding model by id ("Automatic"), else "". A chosen chat model is ignored.
func ResolveEmbedding(list []Model, chosen string) string {
	first := ""
	for _, m := range list {
		if m.Kind != KindEmbedding {
			continue
		}
		if m.ID == chosen {
			return chosen
		}
		if first == "" {
			first = m.ID
		}
	}
	return first
}

// splitPart matches "name-00002-of-00003" (the file name without ".gguf").
var splitPart = regexp.MustCompile(`^(.+)-(\d{5})-of-(\d{5})$`)

// Discover returns every model under root, subfolders included, sorted by ID.
// A missing or empty root is not an error: the user simply has no models yet.
func Discover(root string) ([]Model, error) {
	if root == "" {
		return nil, nil
	}

	var found []Model
	projectors := map[string][]string{}  // folder -> mmproj files, in walk order
	sizes := map[string]int64{}          // folder + id -> bytes, so every part of a split model counts
	partCount := map[string]int{}        // first part's path -> parts in the model
	parts := map[string]map[int]string{} // folder + id -> part number -> path, for split models

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// The root itself missing is fine; anything unreadable deeper is skipped
			// so one bad subfolder doesn't hide all the other models.
			if path == root && errors.Is(err, fs.ErrNotExist) {
				return filepath.SkipAll
			}
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(d.Name()), ".gguf") {
			return nil
		}

		stem := d.Name()[:len(d.Name())-len(".gguf")]
		// Projectors are named both "mmproj-<model>" and "<model>-mmproj"; neither is a model of its own.
		if strings.Contains(strings.ToLower(stem), "mmproj") {
			dir := filepath.Dir(path)
			projectors[dir] = append(projectors[dir], path)
			return nil
		}

		id, first, split := stem, true, splitPart.FindStringSubmatch(stem)
		if split != nil {
			id, first = split[1], split[2] == "00001"
		}
		key := filepath.Join(filepath.Dir(path), id)
		if info, err := d.Info(); err == nil {
			sizes[key] += info.Size()
		}
		if split != nil {
			n, _ := strconv.Atoi(split[2])
			if parts[key] == nil {
				parts[key] = map[int]string{}
			}
			parts[key][n] = path
		}
		if first { // a split model is listed once, via its first part
			found = append(found, Model{ID: id, Path: path})
			if split != nil {
				partCount[path], _ = strconv.Atoi(split[3])
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	byDir := map[string][]int{} // folder -> indexes into found
	for i := range found {
		dir := filepath.Dir(found[i].Path)
		found[i].SizeBytes = sizes[filepath.Join(dir, found[i].ID)]
		found[i].Parts = partsOf(found[i].Path, parts[filepath.Join(dir, found[i].ID)])
		byDir[dir] = append(byDir[dir], i)
	}
	for dir, idx := range byDir {
		ids := make([]string, len(idx))
		for j, i := range idx {
			ids[j] = found[i].ID
		}
		for j, p := range pairProjectors(ids, projectors[dir]) {
			found[idx[j]].MMProj = p
		}
	}

	// WalkDir is lexical, so after a stable sort by ID the first of two
	// same-named models in different folders is the one that wins below.
	sort.SliceStable(found, func(i, j int) bool { return found[i].ID < found[j].ID })
	unique := found[:0]
	for _, m := range found {
		if len(unique) > 0 && unique[len(unique)-1].ID == m.ID {
			continue
		}
		// Read the header only for models that stay listed. Rerankers are hidden until a RAG step can use one.
		info := inspect(m.Path, true)
		m.Kind, m.Error, m.Shape, m.GeneralName = info.kind, info.msg, info.shape, info.name
		blocks := info.blocks
		if n := partCount[m.Path]; n > 1 && m.Kind != KindUnreadable {
			m.Shape, blocks = withParts(m, n, info)
		}
		if have, bad := incomplete(m.Kind, info.blockCount, info.nextn, blocks); bad {
			m.Kind, m.Error = KindUnreadable, IncompleteMessage(have, info.blockCount)
			m.Shape = engine.Shape{FileBytes: m.SizeBytes}
		} else {
			m.Shape.FileBytes = m.SizeBytes
			if m.MMProj != "" {
				if fi, err := os.Stat(m.MMProj); err == nil {
					m.Shape.ProjectorBytes = fi.Size()
				}
			}
		}
		if m.Kind == KindReranker {
			continue
		}
		unique = append(unique, m)
	}
	return unique, nil
}

// partsOf is first followed by the other parts of its split model in part order; just first for a single file.
func partsOf(first string, split map[int]string) []string {
	if !splitPart.MatchString(strings.TrimSuffix(filepath.Base(first), filepath.Ext(first))) {
		return []string{first}
	}
	nums := make([]int, 0, len(split))
	for n := range split {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	out := make([]string, 0, len(nums))
	for _, n := range nums {
		out = append(out, split[n])
	}
	return out
}

// pairProjectors gives each model in one folder its projector, "" if none. Each projector goes to the model whose
// id its file name starts most like (ignoring a leading "mmproj-"); of several projectors for one model, the closest
// wins, the first on a tie. A projector that shares no start with any model (Hugging Face's "mmproj-F16.gguf") is
// used only when the folder holds a single model: guessing among several would start a model with another's
// projector, which llama-server can't load.
func pairProjectors(ids, projectors []string) []string {
	out := make([]string, len(ids))
	best := make([]int, len(ids))
	for _, p := range projectors {
		name := strings.TrimPrefix(strings.ToLower(filepath.Base(p)), "mmproj-")
		owner, ownerLen := -1, 0
		for i, id := range ids {
			if n := commonPrefixLen(strings.ToLower(id), name); n > ownerLen {
				owner, ownerLen = i, n
			}
		}
		if owner == -1 && len(ids) == 1 {
			owner = 0
		}
		if owner >= 0 && (out[owner] == "" || ownerLen > best[owner]) {
			out[owner], best[owner] = p, ownerLen
		}
	}
	return out
}

func commonPrefixLen(a, b string) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}

// withParts completes the shape of a split model from its other parts: the expert tensors of every part count, and a
// part that is missing or whose tensor table doesn't read leaves the shape unknown. The keys are the first part's.
// blocks is the union of every part's layers, nil when the shape is unknown.
func withParts(m Model, n int, first fileInfo) (engine.Shape, []int) {
	s := first.shape
	ok := first.tableOK
	if first.moe {
		s.ExpertBytes = first.rawExperts
	}
	blocks := append([]int(nil), first.blocks...)
	dir := filepath.Dir(m.Path)
	for k := 2; ok && k <= n; k++ {
		part := inspect(filepath.Join(dir, fmt.Sprintf("%s-%05d-of-%05d.gguf", m.ID, k, n)), false)
		if part.kind == KindUnreadable || !part.tableOK {
			ok = false
			break
		}
		if first.moe {
			s.ExpertBytes += part.rawExperts
		}
		blocks = append(blocks, part.blocks...)
	}
	if !ok {
		s.Layers, s.ExpertBytes = 0, 0
		return s, nil
	}
	return s, blocks
}
