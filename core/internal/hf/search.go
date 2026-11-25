package hf

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/url"
	"path"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Repo is one search result.
type Repo struct {
	ID        string    `json:"id"` // "owner/name"
	Owner     string    `json:"owner"`
	Name      string    `json:"name"`
	Downloads int64     `json:"downloads"`
	Likes     int64     `json:"likes"`
	UpdatedAt time.Time `json:"updatedAt"` // Hugging Face's lastModified
	Tags      []string  `json:"tags"`      // ours: Code, MoE, Embeddings; never null
	Quants    int       `json:"quants"`    // usable quant groups, as Files would list them by name (decision 23); ≥ 1
}

// SearchPage is one page of a search.
type SearchPage struct {
	Repos   []Repo // at most 10, never nil
	Page    int    // 0–9
	HasMore bool
}

var ErrBadPage = errors.New("the page must be 0 to 9")

// hfModel is the part of a Hugging Face model listing core reads.
type hfModel struct {
	ID           string    `json:"id"`
	Downloads    int64     `json:"downloads"`
	Likes        int64     `json:"likes"`
	LastModified time.Time `json:"lastModified"`
	Tags         []string  `json:"tags"`
	PipelineTag  string    `json:"pipeline_tag"`
	Siblings     []struct {
		RFilename string `json:"rfilename"`
	} `json:"siblings"`
}

const (
	searchPageSize = 10
	searchMaxPage  = 9
	searchLimit    = "50" // repos per Hugging Face request
	searchMaxAsks  = 10   // Hugging Face requests per query, then done
)

// searchEntry is a query's filtered repos so far and where to read on. It is immutable once stored: extending
// stores a new one.
type searchEntry struct {
	repos []Repo
	seen  map[string]bool // repo IDs, lowercased
	next  *url.URL        // nil before the first request and after the last
	asked int             // Hugging Face requests made for this query
	done  bool
}

// Search returns page (0–9) of the GGUF repos matching q (trimmed, 2–100 characters), 10 a page, in Hugging Face's
// order. ErrBadQuery is checked before ErrBadPage; neither sends a request. A query's repos so far are cached for
// ten minutes, and a page past them reads on from Hugging Face's next cursor. The log holds counts and times, never q.
func (c *Client) Search(ctx context.Context, q string, page int) (SearchPage, error) {
	start := time.Now()
	q = strings.TrimSpace(q)
	if n := utf8.RuneCountInString(q); n < 2 || n > 100 {
		c.log.Warn("hf search failed", "reason", reason(ErrBadQuery), "ms", time.Since(start).Milliseconds())
		return SearchPage{}, ErrBadQuery
	}
	if page < 0 || page > searchMaxPage {
		c.log.Warn("hf search failed", "reason", reason(ErrBadPage), "ms", time.Since(start).Milliseconds())
		return SearchPage{}, ErrBadPage
	}

	// One search at a time, so two calls for the same new query send one request.
	select {
	case c.searchSem <- struct{}{}:
	case <-ctx.Done():
		return SearchPage{}, ctx.Err()
	}
	defer func() { <-c.searchSem }()

	key := "search:" + strings.ToLower(q)
	e := searchEntry{}
	if v, ok := c.cache.get(key); ok {
		e = v.(searchEntry)
	}
	need := min(searchPageSize*(page+1)+1, searchPageSize*(searchMaxPage+1))
	requests := 0
	var err error
	if len(e.repos) < need && !e.done {
		e, requests, err = c.extendSearch(ctx, q, e, need)
		if requests > 0 {
			c.cache.put(key, e) // progress stays, also when a later request failed (decision 22)
		}
	}
	ms := time.Since(start).Milliseconds()
	if err != nil {
		c.log.Warn("hf search failed", "reason", reason(err), "ms", ms)
		return SearchPage{}, err
	}

	answer := SearchPage{Repos: []Repo{}, Page: page, HasMore: page < searchMaxPage && len(e.repos) > searchPageSize*(page+1)}
	if lo := searchPageSize * page; lo < len(e.repos) {
		answer.Repos = slices.Clone(e.repos[lo:min(lo+searchPageSize, len(e.repos))])
	}
	if requests > 0 {
		c.log.Info("hf search", "results", len(answer.Repos), "page", page, "requests", requests, "ms", ms)
	}
	return answer, nil
}

// extendSearch asks Hugging Face for more of q until e holds need repos, has no next page, or has asked
// searchMaxAsks times. It works on a copy and returns it with the number of pages read; a page that fails leaves
// the copy as the pages before it made it.
func (c *Client) extendSearch(ctx context.Context, q string, e searchEntry, need int) (searchEntry, int, error) {
	e.repos = slices.Clone(e.repos)
	e.seen = maps.Clone(e.seen)
	if e.seen == nil {
		e.seen = map[string]bool{}
	}
	read := 0
	for len(e.repos) < need && !e.done {
		if e.asked == searchMaxAsks {
			e.done = true
			break
		}
		u := e.next
		if u == nil {
			u = c.endpoint("/api/models", url.Values{
				"search":    {q},
				"filter":    {"gguf"},
				"sort":      {"downloads"},
				"direction": {"-1"},
				"limit":     {searchLimit},
				"expand[]":  {"downloads", "likes", "lastModified", "tags", "pipeline_tag", "siblings"},
			})
		}
		body, header, err := c.fetch(ctx, u)
		if err != nil {
			return e, read, err
		}
		var list []hfModel
		if err := json.Unmarshal(body, &list); err != nil {
			return e, read, ErrBadAnswer
		}
		next, err := c.nextPage(u, header)
		if err != nil {
			return e, read, err
		}
		read++
		e.asked++
		for _, m := range list {
			if r, ok := searchHit(m, e.seen); ok {
				e.seen[strings.ToLower(m.ID)] = true
				e.repos = append(e.repos, r)
			}
		}
		e.next, e.done = next, next == nil
	}
	return e, read, nil
}

// searchHit is m as a result; false when its ID is unsafe or already listed, it has no gguf tag, or no usable quant.
func searchHit(m hfModel, seen map[string]bool) (Repo, bool) {
	owner, name, ok := splitID(m.ID)
	if !ok || !slices.Contains(m.Tags, "gguf") || seen[strings.ToLower(m.ID)] {
		return Repo{}, false
	}
	names := make([]string, len(m.Siblings))
	for i, s := range m.Siblings {
		names[i] = s.RFilename
	}
	quants := quantCount(names)
	if quants < 1 {
		return Repo{}, false
	}
	return Repo{
		ID:        m.ID,
		Owner:     owner,
		Name:      name,
		Downloads: m.Downloads,
		Likes:     m.Likes,
		UpdatedAt: m.LastModified,
		Tags:      tagsFor(name, m.Tags, m.PipelineTag, false),
		Quants:    quants,
	}, true
}

// quantCount is the number of groups Files would list from these repo paths, judged by name alone: sizes and
// hashes are not in a search answer, so Files may still drop a group counted here (decision 23).
func quantCount(names []string) int {
	entries := make([]treeEntry, len(names))
	for i, n := range names {
		entries[i] = treeEntry{Type: "file", Path: n}
	}
	groups, _ := groupFiles(entries, func(e treeEntry) (GroupFile, bool) {
		return GroupFile{Name: path.Base(e.Path), Path: e.Path}, checkName(e.Path)
	})
	return len(groups)
}
