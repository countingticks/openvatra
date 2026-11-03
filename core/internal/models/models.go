// Package models finds the chat and embedding models on disk.
package models

import (
	"errors"
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Model is one model the user can load.
type Model struct {
	// ID is the file name without ".gguf" (for split models, without the part suffix).
	ID string
	// Path is the file to hand to llama-server; for split models the first part,
	// because llama.cpp finds the remaining parts itself.
	Path string
	// MMProj is the vision projector file in the same folder, or "" if there is none. With several projectors in
	// one folder, the one whose name shares the longest start with the model's (qwen-7b-q4 → qwen-7b-mmproj).
	MMProj string
	// SizeBytes is the size on disk; for split models, all parts together.
	SizeBytes int64
}

// splitPart matches "name-00002-of-00003" (the file name without ".gguf").
var splitPart = regexp.MustCompile(`^(.+)-(\d{5})-of-\d{5}$`)

// Discover returns every model under root, subfolders included, sorted by ID.
// A missing or empty root is not an error: the user simply has no models yet.
func Discover(root string) ([]Model, error) {
	if root == "" {
		return nil, nil
	}

	var found []Model
	projectors := map[string][]string{} // folder -> mmproj files, in walk order
	sizes := map[string]int64{}         // folder + id -> bytes, so every part of a split model counts

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

		id, first := stem, true
		if m := splitPart.FindStringSubmatch(stem); m != nil {
			id, first = m[1], m[2] == "00001"
		}
		if info, err := d.Info(); err == nil {
			sizes[filepath.Join(filepath.Dir(path), id)] += info.Size()
		}
		if first { // a split model is listed once, via its first part
			found = append(found, Model{ID: id, Path: path})
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
		unique = append(unique, m)
	}
	return unique, nil
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
