package budget

import (
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/provider"
)

func user(text string) Turn      { return Turn{Role: "user", Text: text} }
func assistant(text string) Turn { return Turn{Role: "assistant", Text: text} }

// texts lists the role and text of each message after the system one.
func texts(r Result) []string {
	var out []string
	for _, m := range r.Messages[1:] {
		out = append(out, m.Role+":"+m.Parts[0].Text)
	}
	return out
}

func TestFit(t *testing.T) {
	big := strings.Repeat("w", 350) // ~100 tokens + 8

	t.Run("everything fits", func(t *testing.T) {
		r := Fit("SYS", []Turn{user("hi"), assistant("hello"), user("bye")}, 8192, 0)
		if len(r.Messages) != 4 || r.Messages[0].Role != "system" || r.Messages[0].Parts[0] != (provider.Part{Kind: provider.PartText, Text: "SYS"}) {
			t.Fatalf("messages = %+v", r.Messages)
		}
		if got := strings.Join(texts(r), ","); got != "user:hi,assistant:hello,user:bye" {
			t.Fatalf("turns = %s", got)
		}
		// system 1+8, hi 1+8, hello 2+8, bye 1+8
		if r.Dropped != 0 || r.PromptTokens != 37 {
			t.Fatalf("dropped = %d, prompt tokens = %d", r.Dropped, r.PromptTokens)
		}
	})

	t.Run("oldest turns drop first and the newest always stays", func(t *testing.T) {
		// Context 400 → room 100, budget ≈ 283: two turns (216) fit, three (324) don't. Those two are an answer and
		// a question; the answer would lead, so it goes too and only the newest question stays.
		turns := []Turn{user(big), assistant(big), user(big), assistant(big), user("last" + big)}
		r := Fit("S", turns, 400, 0)
		if r.Dropped != 4 || len(r.Messages) != 2 || r.Messages[1].Parts[0].Text != "last"+big {
			t.Fatalf("dropped = %d, messages = %d", r.Dropped, len(r.Messages))
		}
		huge := strings.Repeat("w", 100000)
		r = Fit("S", []Turn{user("old"), assistant("older"), user(huge)}, 400, 0)
		if r.Dropped != 2 || r.Messages[len(r.Messages)-1].Parts[0].Text != huge {
			t.Fatalf("newest turn lost: dropped = %d", r.Dropped)
		}
	})

	t.Run("extraDrop drops two more", func(t *testing.T) {
		turns := []Turn{user("a"), assistant("b"), user("c"), assistant("d"), user("e")}
		r := Fit("S", turns, 8192, 2)
		if got := strings.Join(texts(r), ","); r.Dropped != 2 || got != "user:c,assistant:d,user:e" {
			t.Fatalf("dropped = %d, turns = %s", r.Dropped, got)
		}
		r = Fit("S", turns, 8192, 99)
		if got := strings.Join(texts(r), ","); got != "user:e" {
			t.Fatalf("over-drop left %s", got)
		}
	})

	t.Run("a leading answer is dropped", func(t *testing.T) {
		r := Fit("S", []Turn{user(big), assistant("short"), user(big)}, 300, 0) // budget ≈ 208: fits the last two
		if r.Messages[1].Role != "user" || r.Dropped != 2 {
			t.Fatalf("opens with %s, dropped = %d", r.Messages[1].Role, r.Dropped)
		}
	})
}

func TestAnswerRoom(t *testing.T) {
	t.Run("AnswerRoom caps at 4096", func(t *testing.T) {
		if got := AnswerRoom(8192); got != 2048 {
			t.Fatalf("8k context: got %d, want a quarter", got)
		}
		if got := AnswerRoom(131072); got != 4096 {
			t.Fatalf("128k context: got %d, want the 4k cap", got)
		}
	})
}

func TestEstimateTokens(t *testing.T) {
	t.Run("EstimateTokens rounds up", func(t *testing.T) {
		for in, want := range map[string]int{"": 0, "abcdefg": 2, "abcdefgh": 3, strings.Repeat("x", 35): 10, "ăîș": 1} {
			if got := EstimateTokens(in); got != want {
				t.Errorf("EstimateTokens(%q) = %d, want %d", in, got, want)
			}
		}
	})
}
