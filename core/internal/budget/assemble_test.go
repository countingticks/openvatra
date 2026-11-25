package budget

import (
	"errors"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/event"
)

func msg(seq int64, role, text string) Message {
	return Message{Seq: seq, Role: role, Parts: []event.MessagePart{{Kind: "text", Text: text}}}
}

func reasoned(seq int64, text, reasoning string) Message {
	m := msg(seq, "assistant", text)
	m.Parts = append([]event.MessagePart{{Kind: "reasoning", Text: reasoning}}, m.Parts...)
	return m
}

func quoted(seq int64, quote, text string) Message {
	return Message{Seq: seq, Role: "user", Parts: event.InputParts(text, quote)}
}

// words is a text of n tokens by the estimate.
func words(n int) string { return strings.Repeat("w", n*7/2) }

func sentTexts(p Plan) []string {
	var out []string
	for _, m := range p.Request.Messages {
		out = append(out, m.Role+":"+m.Parts[0].Text)
	}
	return out
}

// chat is n user/assistant turns of tokens tokens per message; seqs count up from 1.
func chat(n, tokens int) []Message {
	var out []Message
	for i := 0; i < n; i++ {
		out = append(out, msg(int64(2*i+1), "user", words(tokens)), msg(int64(2*i+2), "assistant", words(tokens)))
	}
	return out
}

func TestNewWindow(t *testing.T) {
	for _, c := range []struct {
		ctx  int
		want Window
	}{
		{8192, Window{8192, 2048, 6144, 4916, 3072, 819}},
		{16384, Window{16384, 4096, 12288, 9831, 6144, 1638}},
		{131072, Window{131072, 4096, 126976, 118784, 63488, 13107}},
	} {
		if got := NewWindow(c.ctx); got != c.want {
			t.Errorf("NewWindow(%d) = %+v, want %+v", c.ctx, got, c.want)
		}
	}
}

func TestAssembleSend(t *testing.T) {
	w := NewWindow(8192)

	t.Run("a short chat is sent with the system message first", func(t *testing.T) {
		p := Assemble(Input{Model: "m", CacheKey: "k", Fixed: "SYS", Messages: []Message{msg(1, "user", "hi"), msg(2, "assistant", "hello"), msg(3, "user", "bye")}}, w)
		if p.Verdict != Send || p.Request.Model != "m" || p.Request.CacheKey != "k" {
			t.Fatalf("plan = %+v", p)
		}
		if got := strings.Join(sentTexts(p), ","); got != "system:SYS,user:hi,assistant:hello,user:bye" {
			t.Fatalf("sent = %s", got)
		}
		// SYS 1+8, hi 1+8, hello 2+8, bye 1+8
		if p.Tokens != 37 {
			t.Fatalf("tokens = %d", p.Tokens)
		}
	})

	t.Run("the summary joins the system message", func(t *testing.T) {
		p := Assemble(Input{Fixed: "SYS", Summary: &Summary{Text: "TL;DR", FirstKeptSeq: 5, Seq: 9}, Messages: []Message{msg(5, "user", "hi")}}, w)
		want := "system:SYS\n\nSummary of the earlier conversation:\nTL;DR"
		if got := sentTexts(p)[0]; got != want {
			t.Fatalf("system = %q", got)
		}
	})

	t.Run("reasoning, failed, empty and retracted messages are not sent; a stopped partial is", func(t *testing.T) {
		failed := msg(3, "assistant", "broken")
		failed.Failed = true
		retracted := msg(1, "user", "oops")
		retracted.Retracted = true
		empty := Message{Seq: 4, Role: "assistant", Parts: []event.MessagePart{{Kind: "reasoning", Text: "hmm"}}}
		partial := msg(5, "assistant", "half an ans")
		p := Assemble(Input{Fixed: "S", Messages: []Message{retracted, msg(2, "user", "q"), failed, empty, reasoned(6, "full", "secret thoughts"), partial, msg(7, "user", "next")}}, w)
		if got := strings.Join(sentTexts(p), ","); got != "system:S,user:q,assistant:full,assistant:half an ans,user:next" {
			t.Fatalf("sent = %s", got)
		}
	})

	t.Run("Blockquote prefixes each line, and an empty line is a bare >", func(t *testing.T) {
		if got := Blockquote("a\r\n\nb"); got != "> a\n>\n> b" {
			t.Fatalf("Blockquote = %q", got)
		}
		if got := Blockquote(""); got != "" {
			t.Fatalf("Blockquote of nothing = %q", got)
		}
	})

	t.Run("a quoted user message is sent as the blockquote, a blank line, then the text", func(t *testing.T) {
		p := Assemble(Input{Fixed: "S", Messages: []Message{quoted(1, "l1\nl2", "why?")}}, w)
		if got := sentTexts(p)[1]; got != "user:> l1\n> l2\n\nwhy?" {
			t.Fatalf("sent = %q", got)
		}
	})

	t.Run("a quote's tokens count", func(t *testing.T) {
		with := Assemble(Input{Fixed: "S", Messages: []Message{quoted(1, "quote", "text")}}, w)
		without := Assemble(Input{Fixed: "S", Messages: []Message{msg(1, "user", "text")}}, w)
		if got, want := with.Tokens-without.Tokens, EstimateTokens("> quote\n\ntext")-EstimateTokens("text"); got != want {
			t.Fatalf("extra tokens = %d, want %d", got, want)
		}
	})

	t.Run("an empty conversation is the system message alone", func(t *testing.T) {
		p := Assemble(Input{Fixed: "S"}, w)
		if p.Verdict != Send || len(p.Request.Messages) != 1 || p.Request.Messages[0].Role != "system" {
			t.Fatalf("plan = %+v", p)
		}
	})
}

func TestAssembleTokens(t *testing.T) {
	w := NewWindow(8192)
	msgs := []Message{msg(1, "user", "aaaa"), msg(2, "assistant", "bbbb"), msg(3, "user", "cccc")} // 2+8 each
	summaryCost := EstimateTokens(summaryHeading + "x")

	cases := []struct {
		name string
		in   Input
		want int
	}{
		{"estimated without a known size", Input{Fixed: "S", Messages: msgs}, 9 + 30},
		{"known counts the answer and what follows", Input{Fixed: "S", Messages: msgs, Known: Known{PromptTokens: 100, Seq: 2}}, 120},
		{"known after the summary", Input{Fixed: "S", Summary: &Summary{Text: "x", Seq: 1}, Messages: msgs, Known: Known{PromptTokens: 100, Seq: 2}}, 120},
		{"known before the summary is ignored", Input{Fixed: "S", Summary: &Summary{Text: "x", Seq: 5}, Messages: msgs, Known: Known{PromptTokens: 100, Seq: 2}}, 9 + summaryCost + 30},
		{"known not in the messages is ignored", Input{Fixed: "S", Messages: msgs, Known: Known{PromptTokens: 100, Seq: 99}}, 39},
		{"a queued input with a lower seq after the known answer is counted", Input{Fixed: "S", Messages: []Message{msg(1, "user", "aaaa"), msg(5, "assistant", "bbbb"), msg(3, "user", "cccc")}, Known: Known{PromptTokens: 100, Seq: 5}}, 120},
		{"FixedTokens 0 estimates", Input{Fixed: strings.Repeat("s", 70)}, 20 + 8},
		{"a given FixedTokens is used as is", Input{Fixed: strings.Repeat("s", 70), FixedTokens: 50}, 58},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Assemble(c.in, w).Tokens; got != c.want {
				t.Fatalf("tokens = %d, want %d", got, c.want)
			}
		})
	}
}

func TestAssembleRefuse(t *testing.T) {
	w := NewWindow(8192)
	p := Assemble(Input{Fixed: "S", FixedTokens: w.Room/2 + 1, Messages: []Message{msg(1, "user", "hi")}}, w)
	if p.Verdict != Refuse || !errors.Is(p.Err, ErrContextTooSmall) {
		t.Fatalf("plan = %+v", p)
	}
	p = Assemble(Input{Fixed: "S", Messages: []Message{msg(1, "user", words(w.Room))}}, w)
	if p.Verdict != Refuse || !errors.Is(p.Err, ErrMessageTooLong) {
		t.Fatalf("plan = %+v", p)
	}
}

func TestAssembleCompact(t *testing.T) {
	w := NewWindow(8192) // trigger 4916, target 3072

	t.Run("the kept turns are the newest that fit the target", func(t *testing.T) {
		// 12 turns of 816 tokens; with the fixed part three turns stay under 3072.
		p := Assemble(Input{Fixed: "S", Messages: chat(12, 400)}, w)
		if p.Verdict != Compact || p.CutAt != 19 {
			t.Fatalf("plan = %+v", p)
		}
	})

	t.Run("the last two turns are kept even over the target", func(t *testing.T) {
		msgs := append(chat(2, 100), chat(2, 1400)...)
		for i := range msgs {
			msgs[i].Seq = int64(i + 1)
		}
		p := Assemble(Input{Fixed: "S", Messages: msgs}, w)
		if p.Verdict != Compact || p.CutAt != 5 {
			t.Fatalf("plan = %+v", p)
		}
	})

	t.Run("only two turns are sent for the provider to judge", func(t *testing.T) {
		if p := Assemble(Input{Fixed: "S", Messages: chat(2, 1300)}, w); p.Verdict != Send {
			t.Fatalf("plan = %+v", p)
		}
	})

	t.Run("force compacts under the trigger", func(t *testing.T) {
		msgs := chat(4, 400) // 3273 tokens: under the trigger, over the target
		if p := Assemble(Input{Fixed: "S", Messages: msgs}, w); p.Verdict != Send {
			t.Fatalf("unforced plan = %+v", p)
		}
		p := Assemble(Input{Fixed: "S", Messages: msgs, Force: true}, w)
		if p.Verdict != Compact || p.CutAt != 3 {
			t.Fatalf("plan = %+v", p)
		}
	})
}

func TestAssembleToolResults(t *testing.T) {
	w := NewWindow(8192) // ToolCap 819

	t.Run("a long tool result keeps its head and tail", func(t *testing.T) {
		long := strings.Repeat("a", 1000) + strings.Repeat("m", 3000) + strings.Repeat("z", 1000)
		p := Assemble(Input{Fixed: "S", Messages: []Message{msg(1, "user", "go"), msg(2, "tool", long)}}, w)
		got := sentTexts(p)[2]
		if !strings.HasPrefix(got, "tool:"+strings.Repeat("a", 1000)) || !strings.HasSuffix(got, strings.Repeat("z", 1000)) ||
			!strings.Contains(got, "\n[… 611 tokens left out …]\n") || len(got) >= len(long) {
			t.Fatalf("sent = %.80q … len %d", got, len(got))
		}
	})

	t.Run("old tool results are pruned before compacting", func(t *testing.T) {
		msgs := []Message{
			msg(1, "user", words(1700)), msg(2, "assistant", words(1700)),
			msg(3, "user", "go"), msg(4, "tool", words(800)), msg(5, "tool", words(800)), msg(6, "tool", words(800)),
			msg(7, "user", "more"),
		}
		p := Assemble(Input{Fixed: "S", Messages: msgs}, w)
		if p.Verdict != Prune || p.CutAt != 4 {
			t.Fatalf("plan = %+v", p)
		}
		p = Assemble(Input{Fixed: "S", Messages: msgs, PruneTo: 4}, w)
		if p.Verdict != Compact || p.CutAt != 3 {
			t.Fatalf("after pruning, plan = %+v", p)
		}
		// Sent as is once the compaction is out of the way: only the stub differs.
		p = Assemble(Input{Fixed: "S", Messages: msgs[2:], PruneTo: 4}, w)
		if p.Verdict != Send || sentTexts(p)[2] != "tool:[result removed, 800 tokens]" {
			t.Fatalf("stub plan = %+v", sentTexts(p))
		}
	})
}

func TestAssembleParts(t *testing.T) {
	w := NewWindow(8192)
	failed := msg(3, "assistant", "bad")
	failed.Failed = true
	retracted := msg(4, "user", "gone")
	retracted.Retracted = true
	msgs := []Message{msg(1, "user", "aaaa"), msg(2, "assistant", "bbbb"), failed, retracted, msg(5, "user", "cccc")}

	t.Run("without a summary the parts add up and failed or retracted messages are not counted", func(t *testing.T) {
		p := Assemble(Input{Fixed: "S", Messages: msgs}, w)
		if p.Parts.MessageCount != 3 || p.Parts.System+p.Parts.Messages != p.Tokens {
			t.Fatalf("parts = %+v, tokens %d", p.Parts, p.Tokens)
		}
	})
	t.Run("the summary counts as messages, not as system", func(t *testing.T) {
		without := Assemble(Input{Fixed: "S", Messages: msgs}, w)
		with := Assemble(Input{Fixed: "S", Summary: &Summary{Text: "x", Seq: 0}, Messages: msgs}, w)
		if with.Parts.System != without.Parts.System || with.Parts.Messages <= without.Parts.Messages ||
			with.Parts.System+with.Parts.Messages != with.Tokens || with.Parts.MessageCount != 3 {
			t.Fatalf("with %+v, without %+v", with.Parts, without.Parts)
		}
	})
	t.Run("with a known size the parts still add up to the tokens", func(t *testing.T) {
		p := Assemble(Input{Fixed: "S", Messages: msgs, Known: Known{PromptTokens: 100, Seq: 2}}, w)
		if p.Parts.System+p.Parts.Messages != p.Tokens {
			t.Fatalf("parts = %+v, tokens %d", p.Parts, p.Tokens)
		}
	})
	t.Run("a refused plan still has the system part", func(t *testing.T) {
		p := Assemble(Input{Fixed: "S", FixedTokens: w.Room/2 + 1, Messages: msgs}, w)
		if !errors.Is(p.Err, ErrContextTooSmall) || p.Parts.System != w.Room/2+1+perMessageTokens {
			t.Fatalf("plan = %+v", p)
		}
	})
}
