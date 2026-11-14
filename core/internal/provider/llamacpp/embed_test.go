package llamacpp

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/countingticks/openvatra/core/internal/provider"
)

func TestEmbed(t *testing.T) {
	t.Run("vectors in index order", func(t *testing.T) {
		p, _, _ := newFleet(t, map[string]int{"embed": 2048})
		vecs, err := p.Embed(context.Background(), "ignored", []string{"a", "b", "c"})
		if err != nil || len(vecs) != 3 || vecs[0][0] != 0 || vecs[1][0] != 1 || vecs[2][0] != 2 {
			t.Fatalf("Embed = %v, %v", vecs, err)
		}
	})
	t.Run("no embedding model chosen", func(t *testing.T) {
		p, _, _ := newFleet(t, map[string]int{"embed": 2048})
		p.cfg.EmbeddingModel = func() string { return "" }
		if _, err := p.Embed(context.Background(), "", []string{"a"}); !errors.Is(err, provider.ErrNoEmbeddingModel) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("short answer", func(t *testing.T) {
		p, servers, _ := newFleet(t, map[string]int{"embed": 2048})
		servers["embed"].vectors = 1
		_, err := p.Embed(context.Background(), "", []string{"a", "b"})
		if err == nil || err.Error() != "embedding server returned 1 vectors for 2 texts" {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestCount(t *testing.T) {
	p, servers, ev := newFleet(t, map[string]int{"qwen": 8192, "embed": 2048})
	servers["qwen"].tokens = 5
	servers["embed"].tokens = 3
	if n, err := p.Count(context.Background(), "qwen", "hello there"); err != nil || n != 5 {
		t.Fatalf("Count(qwen) = %d, %v", n, err)
	}
	if n, err := p.Count(context.Background(), "embed", "hello"); err != nil || n != 3 {
		t.Fatalf("Count(embed) = %d, %v", n, err)
	}
	if got := ev.get(); !slices.Equal(got, []string{"start qwen", "start embed"}) {
		t.Fatalf("events = %v, want each model in its own slot", got)
	}

	servers["qwen"].failCount.Store(true)
	if _, err := p.Count(context.Background(), "qwen", "x"); err == nil || err.Error() != "tokenize answered 500" {
		t.Fatalf("err = %v", err)
	}
}
