// Package catalog is the short list of tested models the app offers to download, and how each fits this PC.
package catalog

import (
	"bytes"
	_ "embed" // for go:embed below
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"

	"github.com/countingticks/openvatra/core/internal/hw"
)

// The list is compiled into core.exe: it changes with the app and can't be edited from outside.
//
//go:embed catalog.json
var builtin []byte

const gib = 1 << 30

// diskSpare is left free on the drive after a download, so Windows and the other apps keep room to work.
const diskSpare = 2 * gib

// Fit labels, as the UI receives them.
const (
	FitFits   = "fits"   // runs fully on the GPU
	FitSlower = "slower" // part of it runs on the CPU
	FitTooBig = "tooBig" // very slow or won't start; still downloadable after a confirm
)

// Tags say what a model is good at.
var tags = []string{"chat", "code", "vision"}

// File is one file of a model, as Hugging Face lists it at the pinned revision.
type File struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

// Entry is one model of the list.
type Entry struct {
	ID       string   `json:"id"` // ours and stable; also the model's folder name
	Name     string   `json:"name"`
	Summary  string   `json:"summary"`
	Tags     []string `json:"tags"`
	Licence  string   `json:"licence"`
	Repo     string   `json:"repo"`
	Revision string   `json:"revision"` // a commit: the bytes behind it can't change under us
	Files    []File   `json:"files"`
	NeedsGB  int      `json:"needsGB"` // memory to run it comfortably at the default 16 k context
	Rank     int      `json:"rank"`    // higher = better answers; picks the recommendation
}

var (
	safeID    = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*$`)
	safeRepo  = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	safeFile  = regexp.MustCompile(`^[\w][\w.-]*\.gguf$`)
	commit    = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Builtin is the list compiled into core. A test parses it, so a bad edit fails the build, not a user's PC.
func Builtin() ([]Entry, error) { return Parse(builtin) }

// Parse reads and checks a catalog. Ids and file names become paths, so they are held to a strict pattern.
func Parse(data []byte) ([]Entry, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields() // a misspelt key would otherwise be silently empty
	var entries []Entry
	if err := dec.Decode(&entries); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if err := e.validate(); err != nil {
			return nil, fmt.Errorf("catalog entry %q: %w", e.ID, err)
		}
		if seen[e.ID] {
			return nil, fmt.Errorf("catalog entry %q: id used twice", e.ID)
		}
		seen[e.ID] = true
	}
	return entries, nil
}

func (e Entry) validate() error {
	switch {
	case !safeID.MatchString(e.ID):
		return errors.New("id must be lowercase letters, digits, dots and dashes")
	case e.Name == "" || e.Summary == "" || e.Licence == "":
		return errors.New("name, summary and licence are required")
	case !safeRepo.MatchString(e.Repo):
		return errors.New("repo must be owner/name")
	case !commit.MatchString(e.Revision):
		return errors.New("revision must be a full commit sha")
	case len(e.Tags) == 0:
		return errors.New("at least one tag is required")
	case len(e.Files) == 0:
		return errors.New("at least one file is required")
	case e.NeedsGB <= 0:
		return errors.New("needsGB must be positive")
	}
	for _, t := range e.Tags {
		if !slices.Contains(tags, t) {
			return fmt.Errorf("unknown tag %q", t)
		}
	}
	names := map[string]bool{}
	for _, f := range e.Files {
		switch {
		case !safeFile.MatchString(f.Name) || names[f.Name]:
			return fmt.Errorf("file name %q is not a unique plain .gguf name", f.Name)
		case f.SizeBytes <= 0:
			return fmt.Errorf("file %q has no size", f.Name)
		case !sha256Hex.MatchString(f.SHA256):
			return fmt.Errorf("file %q needs a lowercase sha256", f.Name)
		}
		names[f.Name] = true
	}
	return nil
}

// FitFor labels a model that needs needsGB on the PC in r. Only the GPU with the most memory counts (hw picks it).
func FitFor(needsGB int, r hw.Report) string {
	need := uint64(needsGB) * gib
	var vram uint64
	if r.GPU != nil {
		vram = r.GPU.TotalBytes
	}
	switch {
	// 10 % of the graphics memory stays free for the desktop and other apps.
	case r.GPU != nil && need*10 <= vram*9:
		return FitFits
	// llama.cpp puts what doesn't fit on the GPU into RAM; half the RAM is what we dare take. With no GPU, vram is 0.
	case need <= vram+r.RAMBytes/2:
		return FitSlower
	}
	return FitTooBig
}

// Item is an entry as GET /api/catalog shows it for this PC.
type Item struct {
	Entry
	Fit       string `json:"fit"`
	Installed bool   `json:"installed"`
	// DiskShortBytes is how much space is missing to download it (with diskSpare left over); 0 when it fits or is
	// unknown, so an unreadable drive never blocks a download.
	DiskShortBytes uint64 `json:"diskShortBytes"`
}

// View is the JSON of GET /api/catalog. DiskFreeBytes is null when no models folder is set or the drive is unreadable;
// Recommended is null when no chat model fits even slowly.
type View struct {
	Entries       []Item  `json:"entries"`
	DiskFreeBytes *uint64 `json:"diskFreeBytes"`
	Recommended   *string `json:"recommended"`
}

// Errors of Folder.
var (
	ErrUnknown  = errors.New("not a catalog model")
	ErrNoFolder = errors.New("no models folder is set")
)

// Catalog answers for the live hardware report and models folder.
type Catalog struct {
	entries   []Entry
	hardware  func() hw.Report
	modelsDir func() string
	diskFree  func(dir string) (uint64, error) // a seam for tests
}

// New returns a Catalog over entries. hardware and modelsDir are read on every call: both can change while core runs.
func New(entries []Entry, hardware func() hw.Report, modelsDir func() string) *Catalog {
	return &Catalog{entries: entries, hardware: hardware, modelsDir: modelsDir, diskFree: hw.DiskFree}
}

// View labels every entry. Disk space is read fresh each time; it changes as files come and go.
func (c *Catalog) View() View {
	report := c.hardware()
	dir := c.modelsDir()
	free, freeKnown := c.free(dir)

	v := View{Entries: make([]Item, 0, len(c.entries))}
	if freeKnown {
		v.DiskFreeBytes = &free
	}
	for _, e := range c.entries {
		it := Item{Entry: e, Fit: FitFor(e.NeedsGB, report)}
		folder := "" // Join("", id) would be a path relative to core's working folder
		if dir != "" {
			folder = filepath.Join(dir, e.ID)
		}
		missing := missingBytes(folder, e.Files)
		it.Installed = dir != "" && missing == 0
		if freeKnown && missing > 0 && missing+diskSpare > free {
			it.DiskShortBytes = missing + diskSpare - free
		}
		v.Entries = append(v.Entries, it)
	}
	v.Recommended = recommend(v.Entries)
	return v
}

// Folder is where entry id's files go: <modelsDir>/<id>.
func (c *Catalog) Folder(id string) (string, error) {
	if !slices.ContainsFunc(c.entries, func(e Entry) bool { return e.ID == id }) {
		return "", ErrUnknown
	}
	dir := c.modelsDir()
	if dir == "" {
		return "", ErrNoFolder
	}
	return filepath.Join(dir, id), nil
}

// recommend is the best chat model that fits, else the best that runs slower, else none. Ties keep list order.
func recommend(items []Item) *string {
	for _, fit := range []string{FitFits, FitSlower} {
		var pick *Item
		for i := range items {
			it := &items[i]
			if it.Fit == fit && slices.Contains(it.Tags, "chat") && (pick == nil || it.Rank > pick.Rank) {
				pick = it
			}
		}
		if pick != nil {
			return &pick.ID
		}
	}
	return nil
}

// missingBytes adds up the files not yet in folder with their full size. The size is the check: hashing 20 GB on
// every look at the list would be far too slow, and a download only gets its final name once its hash matched.
// An empty folder means nothing is there.
func missingBytes(folder string, files []File) uint64 {
	var n uint64
	for _, f := range files {
		if folder != "" {
			if info, err := os.Stat(filepath.Join(folder, f.Name)); err == nil && info.Mode().IsRegular() && info.Size() == f.SizeBytes {
				continue
			}
		}
		n += uint64(f.SizeBytes)
	}
	return n
}

// free is the space left on the drive of dir. The folder may not exist yet (it is made on the first download), so
// the nearest folder above it that does exist is asked instead.
func (c *Catalog) free(dir string) (uint64, bool) {
	if dir == "" {
		return 0, false
	}
	for d := filepath.Clean(dir); ; {
		if _, err := os.Stat(d); err == nil {
			n, err := c.diskFree(d)
			return n, err == nil
		}
		parent := filepath.Dir(d)
		if parent == d {
			return 0, false
		}
		d = parent
	}
}
