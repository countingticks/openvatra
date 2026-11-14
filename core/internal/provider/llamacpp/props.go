package llamacpp

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

const propsTimeout = 5 * time.Second

// contextSize returns the context size of the ready model l, asking its server (GET /props) the first time. The size
// is cached on l, and every load is a new l, so it never outlives the load it was read from. A failed read gives 0
// and is not cached: the next call asks again.
func (r *Provider) contextSize(ctx context.Context, l *loaded) int {
	if n := l.nCtx.Load(); n > 0 {
		return int(n)
	}
	n := readContextSize(ctx, r.cfg.Client, l.inst.BaseURL())
	if n > 0 {
		l.nCtx.Store(int64(n))
	}
	return n
}

// readContextSize reads default_generation_settings.n_ctx from llama-server's /props, 0 on any failure.
func readContextSize(ctx context.Context, client *http.Client, baseURL string) int {
	ctx, cancel := context.WithTimeout(ctx, propsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/props", nil)
	if err != nil {
		return 0
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0
	}
	var props struct {
		Settings struct {
			NCtx int `json:"n_ctx"`
		} `json:"default_generation_settings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&props); err != nil || props.Settings.NCtx <= 0 {
		return 0
	}
	return props.Settings.NCtx
}
