package profile

import (
	"testing"
	"time"
)

func TestBuiltin(t *testing.T) {
	t.Run("the chat profile fills the date", func(t *testing.T) {
		p, ok := Builtin().Get("chat")
		if !ok {
			t.Fatal("no chat profile")
		}
		got := p.SystemPrompt(time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC))
		want := "You are a helpful assistant running on the user's own computer. Today is Wednesday, 4 November 2026."
		if got != want {
			t.Fatalf("system prompt = %q, want %q", got, want)
		}
		if p.Steps != 1 || !p.Title || len(p.Tools) != 0 || p.MinContext != 0 {
			t.Fatalf("chat profile = %+v", p)
		}
	})

	t.Run("an unknown name is not found", func(t *testing.T) {
		if _, ok := Builtin().Get("nope"); ok {
			t.Fatal("found a profile that does not exist")
		}
	})
}
