package hf

import (
	"context"
	"encoding/json"
	"net/url"
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
}

// hfModel is the part of a Hugging Face model listing core reads.
type hfModel struct {
	ID           string    `json:"id"`
	Downloads    int64     `json:"downloads"`
	Likes        int64     `json:"likes"`
	LastModified time.Time `json:"lastModified"`
	Tags         []string  `json:"tags"`
	PipelineTag  string    `json:"pipeline_tag"`
}

const searchLimit = "30"

// Search lists the GGUF repos matching q (trimmed, 2–100 characters), in Hugging Face's order.
// Answers are cached for ten minutes; the log line holds the count and the time, never q.
func (c *Client) Search(ctx context.Context, q string) ([]Repo, error) {
	start := time.Now()
	q = strings.TrimSpace(q)
	if n := utf8.RuneCountInString(q); n < 2 || n > 100 {
		c.log.Warn("hf search failed", "reason", reason(ErrBadQuery), "ms", time.Since(start).Milliseconds())
		return nil, ErrBadQuery
	}
	key := "search:" + strings.ToLower(q)
	if v, ok := c.cache.get(key); ok {
		return slices.Clone(v.([]Repo)), nil
	}
	repos, err := c.search(ctx, q)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		c.log.Warn("hf search failed", "reason", reason(err), "ms", ms)
		return nil, err
	}
	c.cache.put(key, repos)
	c.log.Info("hf search", "results", len(repos), "ms", ms)
	return slices.Clone(repos), nil
}

func (c *Client) search(ctx context.Context, q string) ([]Repo, error) {
	query := url.Values{
		"search":    {q},
		"filter":    {"gguf"},
		"sort":      {"downloads"},
		"direction": {"-1"},
		"limit":     {searchLimit},
		"expand[]":  {"downloads", "likes", "lastModified", "tags", "pipeline_tag"},
	}
	body, _, err := c.fetch(ctx, c.endpoint("/api/models", query))
	if err != nil {
		return nil, err
	}
	var list []hfModel
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, ErrBadAnswer
	}
	repos := []Repo{}
	for _, m := range list {
		owner, name, ok := splitID(m.ID)
		if !ok || !slices.Contains(m.Tags, "gguf") {
			continue
		}
		repos = append(repos, Repo{
			ID:        m.ID,
			Owner:     owner,
			Name:      name,
			Downloads: m.Downloads,
			Likes:     m.Likes,
			UpdatedAt: m.LastModified,
			Tags:      tagsFor(name, m.Tags, m.PipelineTag, false),
		})
	}
	return repos, nil
}
