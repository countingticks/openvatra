// Package removal takes a model off the disk: it stops the model, moves its files (a catalog entry's whole folder) to
// the Recycle Bin and tidies up after it. Every path is checked against the models folder first, so a bad id, a link
// or a changed setting can never send anything else to the Recycle Bin.
package removal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/provider"
)

// Catalog names an entry's folder and files.
type Catalog interface {
	Folder(id string) (string, error) // catalog.ErrUnknown, catalog.ErrNoFolder
	View() catalog.View
	EntryOf(path string) (id string, ok bool)
}

// Downloads is the download queue a finished download is dismissed from.
type Downloads interface {
	Items() []downloads.DownloadItem
	Cancel(id string) error
}

// Config is what a Remover works with.
type Config struct {
	Resident   provider.Resident
	Catalog    Catalog
	Downloads  Downloads
	ModelsDir  func() string                  // read on every call
	List       func() ([]models.Model, error) // the described list core reports
	Trash      func(path string) error        // trash.Move in production
	Logger     *slog.Logger                   // nil = discard
	Poll       time.Duration                  // 0 = 250 ms; between unload checks
	UnloadWait time.Duration                  // 0 = 15 s
	Retry      time.Duration                  // 0 = 2 s; between Recycle Bin tries
}

// Errors of Remove and RemoveModel, besides catalog.ErrNoFolder, provider.ErrUnknownModel and the context's.
var (
	// ErrUnknownEntry does not wrap catalog.ErrUnknown, which the API answers as an unknown model.
	ErrUnknownEntry  = errors.New("not a catalog model")
	ErrOutside       = errors.New("that folder is not inside the models folder, so it was not removed")
	ErrNotInstalled  = errors.New("that model is not downloaded")
	ErrUnloadTimeout = errors.New("the model did not stop in time, try again")
	ErrModelBusy     = errors.New("that model is answering right now; stop it first")
	// ErrTrashFailed replaces the shell's own error, which says nothing a user can act on.
	ErrTrashFailed = errors.New("Windows could not move the model to the Recycle Bin. A file may still be in use, or the model may be too big for the Recycle Bin. Try again in a moment, or delete its folder in File Explorer.")
)

const trashTries = 3

// Remover removes one model at a time.
type Remover struct {
	cfg Config
	// turn holds one token: a channel rather than a mutex so a caller can give up waiting when its request ends.
	turn chan struct{}
}

// New returns a Remover over cfg, filling in the defaults.
func New(cfg Config) *Remover {
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.Poll <= 0 {
		cfg.Poll = 250 * time.Millisecond
	}
	if cfg.UnloadWait <= 0 {
		cfg.UnloadWait = 15 * time.Second
	}
	if cfg.Retry <= 0 {
		cfg.Retry = 2 * time.Second
	}
	r := &Remover{cfg: cfg, turn: make(chan struct{}, 1)}
	r.turn <- struct{}{}
	return r
}

// Remove takes catalog entry id off the disk. Calls run one at a time, so one folder is never moved twice at once.
func (r *Remover) Remove(ctx context.Context, id string) error {
	if err := r.take(ctx); err != nil {
		return err
	}
	defer r.give()
	return r.removeEntry(ctx, id)
}

// RemoveModel takes model id off the disk: its catalog entry's folder when it has one, else its parts and a projector
// no other model uses. Same turn as Remove: calls never overlap.
func (r *Remover) RemoveModel(ctx context.Context, id string) error {
	if err := r.take(ctx); err != nil {
		return err
	}
	defer r.give()

	dir := r.cfg.ModelsDir()
	if dir == "" {
		return catalog.ErrNoFolder
	}
	list, err := r.cfg.List()
	if err != nil {
		return err
	}
	i := slices.IndexFunc(list, func(m models.Model) bool { return m.ID == id })
	if i < 0 {
		return provider.ErrUnknownModel
	}
	m := list[i]
	// Unloading a model mid-answer would cut a user's run off; they stop it themselves first.
	if slices.ContainsFunc(r.cfg.Resident.States(), func(s provider.ModelState) bool { return s.ID == id && s.Busy }) {
		return ErrModelBusy
	}
	if entry, ok := r.cfg.Catalog.EntryOf(m.Path); ok {
		return r.removeEntry(ctx, entry)
	}

	paths := slices.Clone(m.Parts)
	if len(paths) == 0 {
		paths = []string{m.Path}
	}
	if m.MMProj != "" && !slices.ContainsFunc(list, func(o models.Model) bool {
		return o.ID != id && o.MMProj != "" && strings.EqualFold(filepath.Clean(o.MMProj), filepath.Clean(m.MMProj))
	}) {
		paths = append(paths, m.MMProj)
	}
	for _, p := range paths {
		if !insideResolved(dir, p) {
			return ErrOutside
		}
	}

	if err := r.stop(ctx, []string{id}); err != nil {
		return err
	}
	// Files moved before one that fails stay moved; trash's warnings name the one that didn't.
	for _, p := range paths {
		if err := r.trash(ctx, id, p); err != nil {
			return err
		}
	}
	r.cfg.Resident.Notify()
	return nil
}

func (r *Remover) take(ctx context.Context) error {
	select {
	case <-r.turn:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Remover) give() { r.turn <- struct{}{} }

// removeEntry moves catalog entry id's folder to the Recycle Bin. The caller holds the turn.
func (r *Remover) removeEntry(ctx context.Context, id string) error {
	folder, err := r.cfg.Catalog.Folder(id)
	switch {
	case errors.Is(err, catalog.ErrUnknown):
		return ErrUnknownEntry
	case err != nil:
		return err
	}
	if !inside(r.cfg.ModelsDir(), folder) {
		return ErrOutside
	}
	if _, err := os.Stat(folder); errors.Is(err, os.ErrNotExist) {
		return ErrNotInstalled
	}

	// A loaded model keeps its file open, which would make the Recycle Bin move fail.
	if err := r.stop(ctx, r.modelIDs(id)); err != nil {
		return err
	}
	if err := r.trash(ctx, id, folder); err != nil {
		return err
	}

	// The provider reads the folder only when something it knows about changes; a move to the Recycle Bin isn't one.
	r.cfg.Resident.Notify()
	// Left in the queue, a finished download would read "Almost ready" for a model that is gone. Dismissing it is
	// tidying up, so a failure is only logged: the removal itself worked.
	if slices.ContainsFunc(r.cfg.Downloads.Items(), func(it downloads.DownloadItem) bool {
		return it.ID == id && it.State == downloads.Done
	}) {
		if err := r.cfg.Downloads.Cancel(id); err != nil {
			r.cfg.Logger.Warn("removal: could not dismiss the finished download", "id", id, "err", err)
		}
	}
	return nil
}

// inside reports whether child is strictly inside parent (the folder itself doesn't count). Both are cleaned first,
// so `..` and mixed slashes can't fool it; Windows paths are case-insensitive, hence the lower-casing.
func inside(parent, child string) bool {
	if !filepath.IsAbs(parent) || !filepath.IsAbs(child) {
		return false
	}
	rel, err := filepath.Rel(strings.ToLower(filepath.Clean(parent)), strings.ToLower(filepath.Clean(child)))
	if err != nil { // a different drive
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// insideResolved is inside for path and, when it resolves, for its target too, so a link in the models folder can't
// send a file elsewhere to the Recycle Bin. The models folder is resolved as well (short names, a linked folder).
func insideResolved(dir, path string) bool {
	if !inside(dir, path) {
		return false
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return true // nothing to follow: the move itself fails on a path that isn't there
	}
	if realDir, err := filepath.EvalSymlinks(dir); err == nil {
		dir = realDir
	}
	return inside(dir, real)
}

// modelIDs are the ids the entry's files appear as in the provider: the file names without .gguf.
func (r *Remover) modelIDs(id string) []string {
	var ids []string
	for _, it := range r.cfg.Catalog.View().Entries {
		if it.ID != id {
			continue
		}
		for _, f := range it.Files {
			name := f.Name
			if strings.HasSuffix(strings.ToLower(name), ".gguf") {
				name = name[:len(name)-len(".gguf")]
			}
			ids = append(ids, name)
		}
	}
	return ids
}

// running lists the models of ids that have a server process. A model in error has none and never turns stopped.
func (r *Remover) running(ids []string) []string {
	var out []string
	for _, m := range r.cfg.Resident.States() {
		if slices.Contains(ids, m.ID) && (m.State == provider.StateLoading || m.State == provider.StateReady) {
			out = append(out, m.ID)
		}
	}
	return out
}

func (r *Remover) stop(ctx context.Context, ids []string) error {
	active := r.running(ids)
	if len(active) == 0 {
		return nil
	}
	for _, m := range active {
		r.cfg.Resident.Unload(m)
	}
	deadline := time.Now().Add(r.cfg.UnloadWait)
	for len(r.running(ids)) > 0 {
		if !time.Now().Before(deadline) {
			return ErrUnloadTimeout
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(r.cfg.Poll):
		}
	}
	return nil
}

// trash tries the Recycle Bin a few times: Windows can hold a file for a moment after its process ends, and Defender
// scans a fresh download, both of which make the move fail.
func (r *Remover) trash(ctx context.Context, id, path string) error {
	for try := 1; ; try++ {
		err := r.cfg.Trash(path)
		if err == nil {
			return nil
		}
		r.cfg.Logger.Warn("removal: Recycle Bin move failed", "id", id, "path", path, "try", fmt.Sprintf("%d of %d", try, trashTries), "err", err)
		if try >= trashTries {
			return fmt.Errorf("%w: %v", ErrTrashFailed, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(r.cfg.Retry):
		}
	}
}
