package profile

import (
	"strings"
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

	t.Run("the compaction profile asks for the six headings", func(t *testing.T) {
		p, ok := Builtin().Get("compaction")
		if !ok {
			t.Fatal("no compaction profile")
		}
		if !strings.Contains(p.System, "Objective, Decisions, Done, In progress, Blockers, Files.") {
			t.Fatalf("system prompt = %q", p.System)
		}
		if p.Steps != 1 || p.Title || len(p.Tools) != 0 {
			t.Fatalf("compaction profile = %+v", p)
		}
	})

	t.Run("With replaces a profile of the same name in a copy and adds a new one", func(t *testing.T) {
		base := Builtin()
		chat, _ := base.Get("chat")
		chat.Title = false
		r := base.With(chat).With(Profile{Name: "extra", Steps: 2})
		if got, _ := r.Get("chat"); got.Title || got.System != chat.System {
			t.Fatalf("replaced chat = %+v", got)
		}
		if got, ok := r.Get("extra"); !ok || got.Steps != 2 {
			t.Fatalf("added = %+v, %v", got, ok)
		}
		if _, ok := r.Get("compaction"); !ok {
			t.Fatal("compaction lost")
		}
		if got, _ := base.Get("chat"); !got.Title {
			t.Fatal("With changed the original")
		}
		if _, ok := base.Get("extra"); ok {
			t.Fatal("With added to the original")
		}
	})

	t.Run("an unknown name is not found", func(t *testing.T) {
		if _, ok := Builtin().Get("nope"); ok {
			t.Fatal("found a profile that does not exist")
		}
	})
}
