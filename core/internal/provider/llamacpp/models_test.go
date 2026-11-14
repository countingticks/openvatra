package llamacpp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/countingticks/openvatra/core/internal/provider"
)

// modelServer is a fake llama-server for one model: /props, /tokenize and /v1/embeddings, counting /props calls.
type modelServer struct {
	url       string
	nCtx      int
	props     atomic.Int32 // /props calls
	failProps atomic.Bool  // /props answers 500
	tokens    int          // tokens /tokenize returns
	failCount atomic.Bool  // /tokenize answers 500
	vectors   int          // vectors /v1/embeddings returns; -1 = one per input
}

// newFleet starts one modelServer per id (with nCtx from sizes) and a provider whose instances answer on them. List
// reports every id; "embed" is the embedding model.
func newFleet(t *testing.T, sizes map[string]int) (*Provider, map[string]*modelServer, *eventLog) {
	t.Helper()
	servers := map[string]*modelServer{}
	var list []provider.Model
	for id, n := range sizes {
		ms := &modelServer{nCtx: n, vectors: -1}
		srv := httptest.NewServer(http.HandlerFunc(ms.serve))
		t.Cleanup(srv.Close)
		ms.url = srv.URL
		servers[id] = ms
		kind := provider.ModelChat
		if id == "embed" {
			kind = provider.ModelEmbedding
		}
		list = append(list, provider.Model{ID: id, Kind: kind})
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
	case "/props":
		ms.props.Add(1)
		if ms.failProps.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, `{"default_generation_settings":{"n_ctx":%d}}`, ms.nCtx)
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

func TestModelsGivesContextForLoadedModels(t *testing.T) {
	p, _, _ := newFleet(t, map[string]int{"qwen": 8192, "llama": 4096, "embed": 2048})
	if err := p.Load(context.Background(), "qwen"); err != nil {
		t.Fatal(err)
	}
	if got := contexts(t, p); got["qwen"] != 8192 || got["llama"] != 0 || got["embed"] != 0 {
		t.Fatalf("contexts = %v", got)
	}
	if err := p.Load(context.Background(), "embed"); err != nil {
		t.Fatal(err)
	}
	if got := contexts(t, p); got["qwen"] != 8192 || got["embed"] != 2048 {
		t.Fatalf("contexts with both slots loaded = %v", got)
	}
}

func TestContextSizeIsReadOncePerLoad(t *testing.T) {
	p, servers, ev := newFleet(t, map[string]int{"qwen": 8192})
	qwen := servers["qwen"]
	_ = p.Load(context.Background(), "qwen")
	contexts(t, p)
	contexts(t, p)
	if n := qwen.props.Load(); n != 1 {
		t.Fatalf("/props read %d times in one load, want 1", n)
	}

	p.Unload("qwen")
	waitFor(t, ev, "start qwen", "stop qwen")
	_ = p.Load(context.Background(), "qwen")
	if got := contexts(t, p); got["qwen"] != 8192 || qwen.props.Load() != 2 {
		t.Fatalf("after reload: contexts %v, /props read %d times; want it read again", got, qwen.props.Load())
	}
}

func TestFailedPropsGivesZeroAndIsRetried(t *testing.T) {
	p, servers, _ := newFleet(t, map[string]int{"qwen": 8192})
	qwen := servers["qwen"]
	qwen.failProps.Store(true)
	_ = p.Load(context.Background(), "qwen")
	if got := contexts(t, p); got["qwen"] != 0 {
		t.Fatalf("contexts = %v, want 0 after a failed /props", got)
	}
	qwen.failProps.Store(false)
	if got := contexts(t, p); got["qwen"] != 8192 || qwen.props.Load() != 2 {
		t.Fatalf("contexts = %v after %d reads, want the size on the retry", got, qwen.props.Load())
	}
}

func TestPrepareLoadsAndReportsContext(t *testing.T) {
	p, _, ev := newFleet(t, map[string]int{"qwen": 8192})
	m, err := p.Prepare(context.Background(), "qwen")
	if err != nil || m != (provider.Model{ID: "qwen", Kind: provider.ModelChat, Context: 8192}) {
		t.Fatalf("Prepare = %+v, %v", m, err)
	}

	if _, err := p.Prepare(context.Background(), "missing"); !errors.Is(err, provider.ErrUnknownModel) {
		t.Fatalf("Prepare(missing) err = %v, want ErrUnknownModel", err)
	}
	if st := p.States(); len(st) != 1 || st[0].ID != "qwen" || st[0].State != provider.StateReady {
		t.Fatalf("states = %+v, want qwen still ready", st)
	}
	if got := ev.get(); !equal(got, []string{"start qwen"}) {
		t.Fatalf("events = %v", got)
	}
}
