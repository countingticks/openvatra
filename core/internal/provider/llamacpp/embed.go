package llamacpp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	"github.com/countingticks/openvatra/core/internal/provider"
)

var (
	_ provider.Embedder = (*Provider)(nil)
	_ provider.Counter  = (*Provider)(nil)
)

// Embed embeds texts with the chosen embedding model; the model argument is ignored, like Acquire's for
// provider.KindEmbedding.
func (p *Provider) Embed(ctx context.Context, model string, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	l, release, err := p.acquire(ctx, provider.KindEmbedding, model)
	if err != nil {
		return nil, err
	}
	defer release()

	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	status, err := p.post(ctx, l.inst.BaseURL()+"/v1/embeddings", map[string]any{"model": l.id, "input": texts}, &out)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("embedding server answered %d", status)
	}
	if len(out.Data) != len(texts) {
		return nil, fmt.Errorf("embedding server returned %d vectors for %d texts", len(out.Data), len(texts))
	}
	sort.Slice(out.Data, func(a, b int) bool { return out.Data[a].Index < out.Data[b].Index })
	vecs := make([][]float32, len(out.Data))
	for i, d := range out.Data {
		vecs[i] = d.Embedding
	}
	return vecs, nil
}

// Count returns how many tokens model's tokenizer makes of text. The embedding model counts in its own slot, any
// other model in the chat slot (the Load rule).
func (p *Provider) Count(ctx context.Context, model string, text string) (int, error) {
	kind := provider.KindChat
	if model == p.cfg.EmbeddingModel() {
		kind = provider.KindEmbedding
	}
	l, release, err := p.acquire(ctx, kind, model)
	if err != nil {
		return 0, err
	}
	defer release()

	var out struct {
		Tokens []json.RawMessage `json:"tokens"` // ids, or objects when pieces are asked for
	}
	status, err := p.post(ctx, l.inst.BaseURL()+"/tokenize", map[string]any{"content": text}, &out)
	if err != nil {
		return 0, err
	}
	if status != http.StatusOK {
		return 0, fmt.Errorf("tokenize answered %d", status)
	}
	return len(out.Tokens), nil
}

// post sends body as JSON and decodes a 200 answer into out. It returns the status for the caller's own wording.
func (p *Provider) post(ctx context.Context, url string, body any, out any) (int, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.cfg.Client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
}
