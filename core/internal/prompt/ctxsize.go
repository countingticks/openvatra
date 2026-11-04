package prompt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// ContextSizes asks llama-server how big its context is (GET /props) and remembers the answer. The key is the
// server's base URL: the router starts a new server (new port) every time a model is loaded, so a cached size can
// never outlive the load it was read from.
type ContextSizes struct {
	Client *http.Client // nil: a client with a 5 s timeout

	mu    sync.Mutex
	sizes map[string]int
}

// Get returns the context size in tokens of the server at baseURL.
func (c *ContextSizes) Get(ctx context.Context, baseURL string) (int, error) {
	c.mu.Lock()
	n, ok := c.sizes[baseURL]
	c.mu.Unlock()
	if ok {
		return n, nil
	}

	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/props", nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("read context size: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("read context size: server answered %d", resp.StatusCode)
	}
	var props struct {
		Settings struct {
			NCtx int `json:"n_ctx"`
		} `json:"default_generation_settings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&props); err != nil {
		return 0, fmt.Errorf("read context size: %w", err)
	}
	if props.Settings.NCtx <= 0 {
		return 0, fmt.Errorf("read context size: server reported no n_ctx")
	}

	c.mu.Lock()
	if c.sizes == nil {
		c.sizes = map[string]int{}
	}
	c.sizes[baseURL] = props.Settings.NCtx
	c.mu.Unlock()
	return props.Settings.NCtx, nil
}
