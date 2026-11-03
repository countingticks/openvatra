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
	// MMProj is the vision projector file in the same folder, or "" if there is none.
	MMProj string
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
		if strings.HasPrefix(strings.ToLower(stem), "mmproj") {
			dir := filepath.Dir(path)
			projectors[dir] = append(projectors[dir], path)
			return nil
		}

		id := stem
		if m := splitPart.FindStringSubmatch(stem); m != nil {
			if m[2] != "00001" {
				return nil // counted once, via its first part
			}
			id = m[1]
		}
		found = append(found, Model{ID: id, Path: path})
		return nil
	})
	if err != nil {
		return nil, err
	}

	for i := range found {
		if p := projectors[filepath.Dir(found[i].Path)]; len(p) > 0 {
			found[i].MMProj = p[0]
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
