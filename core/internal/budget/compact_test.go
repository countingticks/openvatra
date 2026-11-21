package budget

import (
	"strings"
	"testing"
)

func pieceLines(piece []Message) string {
	r := CompactRequest("m", "SYS", "", piece, NewWindow(8192))
	return r.Messages[1].Parts[0].Text
}

func TestSummaryMax(t *testing.T) {
	// min(AnswerRoom, Target/2): 8,192 → min(2048, 1536); 16,384 → min(4096, 3072)
	if got := SummaryMax(NewWindow(8192)); got != 1536 {
		t.Errorf("8192: %d", got)
	}
	if got := SummaryMax(NewWindow(16384)); got != 3072 {
		t.Errorf("16384: %d", got)
	}
}

func TestPieces(t *testing.T) {
	w := NewWindow(8192) // limit = 6144 - 20 - 3072 - 16 = 3036

	t.Run("everything fits one piece", func(t *testing.T) {
		p := Pieces(chat(3, 20), w, 20)
		if len(p) != 1 || len(p[0]) != 6 {
			t.Fatalf("pieces = %d", len(p))
		}
	})

	t.Run("no messages, no pieces", func(t *testing.T) {
		if p := Pieces(nil, w, 20); len(p) != 0 {
			t.Fatalf("pieces = %v", p)
		}
	})

	t.Run("a long history splits oldest first, each piece within budget", func(t *testing.T) {
		msgs := chat(10, 400)
		pieces := Pieces(msgs, w, 20)
		if len(pieces) < 2 {
			t.Fatalf("pieces = %d", len(pieces))
		}
		var seq int64
		for _, p := range pieces {
			cost := 0
			for _, m := range p {
				if m.Seq <= seq {
					t.Fatalf("seq %d after %d", m.Seq, seq)
				}
				seq = m.Seq
				l, _ := line(m)
				cost += EstimateTokens(l)
			}
			if cost > 3036 {
				t.Fatalf("piece costs %d", cost)
			}
		}
		if seq != 20 {
			t.Fatalf("last seq = %d", seq)
		}
	})

	t.Run("a single message over the budget is cut and marked", func(t *testing.T) {
		p := Pieces([]Message{msg(1, "user", words(5000))}, w, 20)
		if len(p) != 1 {
			t.Fatalf("pieces = %d", len(p))
		}
		l, _ := line(p[0][0])
		if !strings.HasSuffix(l, "[…]") || EstimateTokens(l) > 3036 {
			t.Fatalf("line of %d tokens ends %q", EstimateTokens(l), l[len(l)-10:])
		}
	})

	t.Run("reasoning, failed and retracted messages are left out", func(t *testing.T) {
		failed := msg(3, "assistant", "FAILED")
		failed.Failed = true
		gone := msg(4, "user", "RETRACTED")
		gone.Retracted = true
		p := Pieces([]Message{msg(1, "user", "q"), reasoned(2, "a", "THOUGHTS"), failed, gone}, w, 20)
		text := pieceLines(p[0])
		if len(p[0]) != 2 || strings.Contains(text, "THOUGHTS") || strings.Contains(text, "FAILED") || strings.Contains(text, "RETRACTED") {
			t.Fatalf("text = %q", text)
		}
	})
}

func TestCompactRequest(t *testing.T) {
	w := NewWindow(8192)
	piece := []Message{msg(1, "user", "hi"), msg(2, "assistant", "hello"), msg(3, "tool", "result")}

	r := CompactRequest("m", "SYS", "", piece, w)
	want := "Previous summary:\nnone\n\nConversation to summarise:\nUser: hi\n\nAssistant: hello\n\nTool: result\n\nWrite the new summary."
	if r.Model != "m" || !r.NoThinking || r.MaxOut != SummaryMax(w) || r.CacheKey != "" || len(r.Messages) != 2 ||
		r.Messages[0].Role != "system" || r.Messages[0].Parts[0].Text != "SYS" || r.Messages[1].Role != "user" ||
		r.Messages[1].Parts[0].Text != want {
		t.Fatalf("request = %+v", r)
	}

	r = CompactRequest("m", "SYS", "OLD", piece, w)
	if !strings.HasPrefix(r.Messages[1].Parts[0].Text, "Previous summary:\nOLD\n\n") {
		t.Fatalf("user = %q", r.Messages[1].Parts[0].Text)
	}
}
