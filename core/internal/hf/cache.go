package hf

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"
)

const (
	cacheTTL = 10 * time.Minute
	cacheMax = 50
)

// cache keeps Hugging Face's parsed answers in memory only; nothing about a search reaches the disk. Its mutex is
// never held during a request, so two calls for the same key may both ask, and the later answer wins.
type cache struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]cacheEntry
	order   []string // keys, oldest added first
}

type cacheEntry struct {
	value any
	added time.Time
}

func newCache(now func() time.Time) *cache {
	return &cache{now: now, entries: map[string]cacheEntry{}}
}

// get is the value under key while it is younger than ten minutes.
func (c *cache) get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || c.now().Sub(e.added) >= cacheTTL {
		return nil, false
	}
	return e.value, true
}

// put stores value under key as the newest entry, dropping the oldest added past fifty.
func (c *cache) put(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[key]; ok {
		c.order = slices.DeleteFunc(c.order, func(k string) bool { return k == key })
	}
	for len(c.order) >= cacheMax {
		delete(c.entries, c.order[0])
		c.order = c.order[1:]
	}
	c.entries[key] = cacheEntry{value: value, added: c.now()}
	c.order = append(c.order, key)
}

// reason is a failure as a log value: never err.Error(), as a url.Error holds the URL and so the query.
func reason(err error) string {
	switch {
	case errors.Is(err, ErrBadQuery):
		return "bad query"
	case errors.Is(err, ErrUnreachable):
		return "unreachable"
	case errors.Is(err, ErrRepoNotFound):
		return "not found"
	case errors.Is(err, ErrGated):
		return "gated"
	case errors.Is(err, ErrRateLimited):
		return "rate limited"
	case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
		return "cancelled"
	default:
		return "bad answer"
	}
}
