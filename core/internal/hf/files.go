package hf

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/hw"
	"github.com/countingticks/openvatra/core/internal/models"
)

// Listing is a repo's GGUF files at its current revision, judged against this PC.
type Listing struct {
	Repo          string   `json:"repo"`          // "owner/name"
	Revision      string   `json:"revision"`      // the commit sha the files were read at
	Tags          []string `json:"tags"`          // Repo's tags, plus Vision when a group has a projector; never null
	Groups        []Group  `json:"groups"`        // never null
	DiskFreeBytes *uint64  `json:"diskFreeBytes"` // null when no models folder is set or the drive is unreadable
}

// Group is one quant of a model: its parts and the projector, if the repo has one.
type Group struct {
	Quant     string      `json:"quant"`
	Files     []GroupFile `json:"files"`     // model parts in part order, then the projector
	SizeBytes int64       `json:"sizeBytes"` // all files, projector included
	Fit       string      `json:"fit" enum:"fits,slower,tooBig"`
	Installed bool        `json:"installed"`
}

// GroupFile, not File: the OpenAPI document already has catalog.File, and two types may not share a name.
type GroupFile struct {
	Name      string `json:"name"` // the base name, as saved on disk
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
	Path      string `json:"-"` // the path inside the repo, for the download URL
	Projector bool   `json:"-"` // the vision projector; false for model parts
}

var (
	ErrRepoNotFound = errors.New("there is no such model on Hugging Face")
	ErrGated        = errors.New("This model needs a Hugging Face account")
)

const (
	// runOverhead is added to a group's bytes for the fit estimate: the context and llama.cpp's own buffers.
	runOverhead = 3 << 29 // 1.5 GiB
	maxPages    = 20
)

var (
	commitRe   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Re   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	pathSegRe  = regexp.MustCompile(`^[\w][\w.-]*$`)
	baseNameRe = regexp.MustCompile(`(?i)^[\w][\w.-]*\.gguf$`)
	// splitPart matches "name-00002-of-00003" (the file name without ".gguf"), as in models.
	splitPart = regexp.MustCompile(`^(.+)-(\d{5})-of-(\d{5})$`)
)

// repoInfo is the part of GET /api/models/<repo> core reads.
type repoInfo struct {
	SHA         string          `json:"sha"`
	Gated       json.RawMessage `json:"gated"` // false, or "auto" / "manual"
	Private     bool            `json:"private"`
	Tags        []string        `json:"tags"`
	PipelineTag string          `json:"pipeline_tag"`
}

// treeEntry is one entry of GET /api/models/<repo>/tree/<sha>.
type treeEntry struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		OID string `json:"oid"`
	} `json:"lfs"`
}

// repoAnswer is what Hugging Face said about a repo; the part of Files that may be cached.
type repoAnswer struct {
	info repoInfo
	tree []treeEntry
}

// Files lists owner/name's GGUF groups.
// Hugging Face's answer is cached for ten minutes; fit, installed and disk space are worked out on every call.
func (c *Client) Files(ctx context.Context, owner, name string) (Listing, error) {
	start := time.Now()
	repo := owner + "/" + name
	if !safeSegment(owner) || !safeSegment(name) {
		c.log.Warn("hf files failed", "repo", repo, "reason", reason(ErrRepoNotFound))
		return Listing{}, ErrRepoNotFound
	}
	key := "files:" + strings.ToLower(repo)
	if v, ok := c.cache.get(key); ok {
		return c.listing(owner, name, v.(repoAnswer)), nil
	}
	answer, err := c.askRepo(ctx, owner, name)
	if err != nil {
		c.log.Warn("hf files failed", "repo", repo, "reason", reason(err))
		return Listing{}, err
	}
	c.cache.put(key, answer)
	l := c.listing(owner, name, answer)
	c.log.Info("hf files", "repo", repo, "groups", len(l.Groups), "ms", time.Since(start).Milliseconds())
	return l, nil
}

// Folder is where a group's files go: <modelsDir>/hf/<owner>/<name>/<quant>; "" when modelsDir is "".
func Folder(modelsDir, repo, quant string) string {
	if modelsDir == "" {
		return ""
	}
	owner, name, _ := strings.Cut(repo, "/")
	return filepath.Join(modelsDir, "hf", owner, name, quant)
}

// askRepo reads the repo's info, then its file tree at the revision the info names.
func (c *Client) askRepo(ctx context.Context, owner, name string) (repoAnswer, error) {
	repoPath := "/api/models/" + owner + "/" + name
	body, _, err := c.fetch(ctx, c.endpoint(repoPath, nil))
	if err != nil {
		var se *statusError
		if errors.As(err, &se) && (se.code == http.StatusUnauthorized || se.code == http.StatusNotFound) {
			return repoAnswer{}, ErrRepoNotFound
		}
		return repoAnswer{}, err
	}
	var info repoInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return repoAnswer{}, ErrBadAnswer
	}
	switch {
	case info.Private:
		return repoAnswer{}, ErrRepoNotFound
	case string(info.Gated) != "false":
		return repoAnswer{}, ErrGated
	case !commitRe.MatchString(info.SHA):
		return repoAnswer{}, ErrBadAnswer
	}

	var tree []treeEntry
	next := c.endpoint(repoPath+"/tree/"+info.SHA, url.Values{"recursive": {"true"}})
	for page := 1; next != nil; page++ {
		if page > maxPages {
			return repoAnswer{}, ErrBadAnswer
		}
		body, header, err := c.fetch(ctx, next)
		if err != nil {
			return repoAnswer{}, err
		}
		var entries []treeEntry
		if err := json.Unmarshal(body, &entries); err != nil {
			return repoAnswer{}, ErrBadAnswer
		}
		tree = append(tree, entries...)
		if next, err = c.nextPage(next, header); err != nil {
			return repoAnswer{}, err
		}
	}
	return repoAnswer{info: info, tree: tree}, nil
}

// nextPage is the Link header's rel="next" target, resolved against the page it came with; nil when there is
// none. A next page on another host than the base's is a bad answer.
func (c *Client) nextPage(current *url.URL, header http.Header) (*url.URL, error) {
	for _, link := range header.Values("Link") {
		for part := range strings.SplitSeq(link, ",") {
			target, params, ok := strings.Cut(strings.TrimSpace(part), ";")
			if !ok || !strings.Contains(strings.ReplaceAll(params, " ", ""), `rel="next"`) {
				continue
			}
			target = strings.TrimSpace(target)
			if !strings.HasPrefix(target, "<") || !strings.HasSuffix(target, ">") {
				return nil, ErrBadAnswer
			}
			u, err := current.Parse(strings.TrimSuffix(strings.TrimPrefix(target, "<"), ">"))
			if err != nil || u.Scheme != c.base.Scheme || u.Host != c.base.Host {
				return nil, ErrBadAnswer
			}
			return u, nil
		}
	}
	return nil, nil
}

// rawGroup collects the model files that share a folder and stem.
type rawGroup struct {
	key   string // folder + stem, split suffix removed
	stem  string
	total int // parts announced; 0 for a single file
	parts map[int]GroupFile
	bad   bool
}

// listing judges a repo's answer against this PC. Only this part runs on a cache hit: fit, installed and disk
// space change while core runs.
func (c *Client) listing(owner, name string, a repoAnswer) Listing {
	repo := owner + "/" + name
	byKey := map[string]*rawGroup{}
	var keys []string
	var projectors []GroupFile
	for _, e := range a.tree {
		if e.Type != "file" || !strings.HasSuffix(strings.ToLower(e.Path), ".gguf") {
			continue
		}
		f, ok := checkFile(e)
		base := path.Base(e.Path)
		if strings.Contains(strings.ToLower(base), "mmproj") {
			if ok {
				projectors = append(projectors, f)
			}
			continue
		}
		stem := base[:len(base)-len(".gguf")]
		part, total := 0, 0
		if m := splitPart.FindStringSubmatch(stem); m != nil {
			stem = m[1]
			part, _ = strconv.Atoi(m[2])
			total, _ = strconv.Atoi(m[3])
		}
		key := path.Join(path.Dir(e.Path), stem)
		g := byKey[key]
		if g == nil {
			g = &rawGroup{key: key, stem: stem, total: total, parts: map[int]GroupFile{}}
			byKey[key] = g
			keys = append(keys, key)
		}
		if _, dup := g.parts[part]; dup || g.total != total || !ok {
			g.bad = true
		}
		g.parts[part] = f
	}

	var usable []*rawGroup
	quants := map[string]int{}
	for _, k := range keys {
		if g := byKey[k]; complete(g) {
			usable = append(usable, g)
			quants[models.Quant(g.key)]++
		}
	}
	labels := map[string]int{}
	labelOf := map[*rawGroup]string{}
	for _, g := range usable {
		label := models.Quant(g.key)
		if label == "" || quants[label] > 1 {
			label = g.stem
		}
		labelOf[g] = label
		labels[label]++
	}

	projector, hasProjector := pickProjector(projectors)
	projector.Projector = true
	report := c.hardware()
	dir := c.modelsDir()
	groups := []Group{}
	for _, g := range usable {
		label := labelOf[g]
		if labels[label] > 1 {
			continue
		}
		files := make([]GroupFile, 0, len(g.parts)+1)
		for _, p := range slices.Sorted(maps.Keys(g.parts)) {
			files = append(files, g.parts[p])
		}
		if hasProjector {
			files = append(files, projector)
		}
		if !uniqueNames(files) {
			continue
		}
		var size int64
		for _, f := range files {
			size += f.SizeBytes
		}
		groups = append(groups, Group{
			Quant:     label,
			Files:     files,
			SizeBytes: size,
			Fit:       catalog.FitForBytes(uint64(size)+runOverhead, report),
			Installed: installed(Folder(dir, repo, label), files),
		})
	}
	slices.SortFunc(groups, func(x, y Group) int {
		return cmp.Or(cmp.Compare(x.SizeBytes, y.SizeBytes), cmp.Compare(x.Quant, y.Quant))
	})

	l := Listing{
		Repo:     repo,
		Revision: a.info.SHA,
		Tags:     tagsFor(name, a.info.Tags, a.info.PipelineTag, hasProjector && len(groups) > 0),
		Groups:   groups,
	}
	if free, ok := hw.FreeNear(dir, c.diskFree); ok {
		l.DiskFreeBytes = &free
	}
	return l
}

// checkFile turns a tree entry into a GroupFile; false when its path, name, size or sha256 is not safe to use
// (decision 35).
func checkFile(e treeEntry) (GroupFile, bool) {
	f := GroupFile{Name: path.Base(e.Path), SizeBytes: e.Size, Path: e.Path}
	if e.LFS != nil {
		f.SHA256 = e.LFS.OID
	}
	for seg := range strings.SplitSeq(e.Path, "/") {
		if !pathSegRe.MatchString(seg) {
			return f, false
		}
	}
	return f, baseNameRe.MatchString(f.Name) && sha256Re.MatchString(f.SHA256) && e.Size > 0
}

// complete reports whether g has no bad file and, when split, every part from 1 to its total.
func complete(g *rawGroup) bool {
	if g.bad {
		return false
	}
	if g.total == 0 {
		return len(g.parts) == 1
	}
	for p := 1; p <= g.total; p++ {
		if _, ok := g.parts[p]; !ok {
			return false
		}
	}
	return len(g.parts) == g.total
}

// pickProjector prefers F16, then BF16, then the smallest; ties go to the first by path.
func pickProjector(list []GroupFile) (GroupFile, bool) {
	if len(list) == 0 {
		return GroupFile{}, false
	}
	list = slices.Clone(list)
	slices.SortFunc(list, func(x, y GroupFile) int { return cmp.Compare(x.Path, y.Path) })
	for _, want := range []string{"F16", "BF16"} {
		for _, p := range list {
			if models.Quant(strings.TrimSuffix(p.Name, path.Ext(p.Name))) == want {
				return p, true
			}
		}
	}
	return slices.MinFunc(list, func(x, y GroupFile) int { return cmp.Compare(x.SizeBytes, y.SizeBytes) }), true
}

// uniqueNames reports whether no two files would land on the same name on disk (Windows ignores case).
func uniqueNames(files []GroupFile) bool {
	seen := map[string]bool{}
	for _, f := range files {
		k := strings.ToLower(f.Name)
		if seen[k] {
			return false
		}
		seen[k] = true
	}
	return true
}

// installed reports whether folder holds every file as a regular file of its full size. The size is the check, as
// in the catalog: a download gets its final name only once its hash matched.
func installed(folder string, files []GroupFile) bool {
	if folder == "" {
		return false
	}
	for _, f := range files {
		info, err := os.Stat(filepath.Join(folder, f.Name))
		if err != nil || !info.Mode().IsRegular() || info.Size() != f.SizeBytes {
			return false
		}
	}
	return true
}
