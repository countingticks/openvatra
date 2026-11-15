package llamacpp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/countingticks/openvatra/core/internal/provider"
)

// modelServer is a fake llama-server for one model: /tokenize and /v1/embeddings.
type modelServer struct {
	url       string
	tokens    int         // tokens /tokenize returns
	failCount atomic.Bool // /tokenize answers 500
	vectors   int         // vectors /v1/embeddings returns; -1 = one per input
}

// newFleet starts one modelServer per id and a provider whose instances answer on them. List reports every id, each
// chat model with its context from sizes; "embed" is the embedding model.
func newFleet(t *testing.T, sizes map[string]int) (*Provider, map[string]*modelServer, *eventLog) {
	t.Helper()
	servers := map[string]*modelServer{}
	var list []provider.Model
	for id, n := range sizes {
		ms := &modelServer{vectors: -1}
		srv := httptest.NewServer(http.HandlerFunc(ms.serve))
		t.Cleanup(srv.Close)
		ms.url = srv.URL
		servers[id] = ms
		m := provider.Model{ID: id, Kind: provider.ModelChat, Context: n}
		if id == "embed" {
			m = provider.Model{ID: id, Kind: provider.ModelEmbedding}
		}
		list = append(list, m)
	}
	slices.SortFunc(list, func(a, b provider.Model) int { return strings.Compare(a.ID, b.ID) })
	ev := &eventLog{}
	p := newServerProvider(ev, func(id string) string {
		if ms, ok := servers[id]; ok {
			return ms.url
		}
		return ""
	})
	p.cfg.List = func() ([]provider.Model, error) { return slices.Clone(list), nil }
	return p, servers, ev
}

func (ms *modelServer) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/tokenize":
		if ms.failCount.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		toks := make([]int, ms.tokens)
		_ = json.NewEncoder(w).Encode(map[string]any{"tokens": toks})
	case "/v1/embeddings":
		var in struct {
			Input []string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		n := ms.vectors
		if n < 0 {
			n = len(in.Input)
		}
		// Answered in reverse order, so the caller has to sort by index.
		var data []map[string]any
		for i := n - 1; i >= 0; i-- {
			data = append(data, map[string]any{"index": i, "embedding": []float32{float32(i)}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	default:
		http.NotFound(w, r)
	}
}

func contexts(t *testing.T, p *Provider) map[string]int {
	t.Helper()
	models, err := p.Models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, m := range models {
		out[m.ID] = m.Context
	}
	return out
}

func TestModelsReportsListContextsAndStartsNothing(t *testing.T) {
	p, _, ev := newFleet(t, map[string]int{"qwen": 8192, "llama": 4096, "embed": 2048})
	if got := contexts(t, p); got["qwen"] != 8192 || got["llama"] != 4096 || got["embed"] != 0 {
		t.Fatalf("contexts = %v", got)
	}
	if got := ev.get(); len(got) != 0 {
		t.Fatalf("events = %v, want no server started", got)
	}
}

func TestModelLooksUpWithoutLoading(t *testing.T) {
	p, _, ev := newFleet(t, map[string]int{"qwen": 8192})
	m, err := p.Model(context.Background(), "qwen")
	if err != nil || m != (provider.Model{ID: "qwen", Kind: provider.ModelChat, Context: 8192}) {
		t.Fatalf("Model = %+v, %v", m, err)
	}
	if _, err := p.Model(context.Background(), "missing"); !errors.Is(err, provider.ErrUnknownModel) {
		t.Fatalf("Model(missing) err = %v, want ErrUnknownModel", err)
	}
	if got, st := ev.get(), p.States(); len(got) != 0 || len(st) != 0 {
		t.Fatalf("events %v, states %+v; want nothing started", got, st)
	}

	boom := errors.New("folder gone")
	p.cfg.List = func() ([]provider.Model, error) { return nil, boom }
	if _, err := p.Model(context.Background(), "qwen"); err != boom {
		t.Fatalf("err = %v, want the List error", err)
	}
	p.cfg.List = nil
	if _, err := p.Model(context.Background(), "qwen"); !errors.Is(err, provider.ErrUnknownModel) {
		t.Fatalf("nil List: err = %v, want ErrUnknownModel", err)
	}
}
