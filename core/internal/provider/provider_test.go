package provider

import (
	"errors"
	"testing"
)

func TestAppendDelta(t *testing.T) {
	text := func(s string) Delta { return Delta{Kind: PartText, Text: s} }
	call := func(id string) Delta { return Delta{Kind: PartToolCall, Call: &ToolCall{ID: id}} }
	collect := func(ds ...Delta) []Part {
		var parts []Part
		for _, d := range ds {
			parts = AppendDelta(parts, d)
		}
		return parts
	}

	t.Run("text, text, reasoning, text gives three parts", func(t *testing.T) {
		got := collect(text("a"), text("b"), Delta{Kind: PartReasoning, Text: "hm"}, text("c"))
		if len(got) != 3 || got[0].Text != "ab" || got[1].Kind != PartReasoning || got[1].Text != "hm" || got[2].Text != "c" {
			t.Fatalf("parts = %+v", got)
		}
	})
	t.Run("two tool calls give two parts in order", func(t *testing.T) {
		got := collect(call("1"), call("2"))
		if len(got) != 2 || got[0].Call.ID != "1" || got[1].Call.ID != "2" || got[0].Kind != PartToolCall {
			t.Fatalf("parts = %+v", got)
		}
	})
	t.Run("an empty delta adds nothing", func(t *testing.T) {
		if got := collect(text("a"), Delta{Kind: PartText}); len(got) != 1 || got[0].Text != "a" {
			t.Fatalf("parts = %+v", got)
		}
		if got := collect(Delta{Kind: PartText}); len(got) != 0 {
			t.Fatalf("parts = %+v", got)
		}
	})
}

func TestLoadError(t *testing.T) {
	cause := errors.New("exited")
	err := error(&LoadError{Model: "qwen", Err: cause})
	if err.Error() != "load qwen: exited" {
		t.Fatalf("Error() = %q", err.Error())
	}
	if !errors.Is(err, cause) {
		t.Fatal("errors.Is does not reach the wrapped error")
	}
}
