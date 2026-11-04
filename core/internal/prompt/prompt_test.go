package prompt

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/store"
)

func msg(id, role, content string) store.Message {
	return store.Message{ID: id, Role: role, Content: content, Status: store.StatusDone}
}

func TestSystemPromptHasTheDate(t *testing.T) {
	got := SystemPrompt(time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC))
	if !strings.Contains(got, "Today is Wednesday, 4 November 2026.") {
		t.Fatalf("no date in %q", got)
	}
}

func TestAnswerRoom(t *testing.T) {
	if got := AnswerRoom(8192); got != 2048 {
		t.Fatalf("8k context: got %d, want a quarter", got)
	}
	if got := AnswerRoom(131072); got != 4096 {
		t.Fatalf("128k context: got %d, want the 4k cap", got)
	}
}

func TestEstimateTokens(t *testing.T) {
	if EstimateTokens("") != 0 || EstimateTokens("abcdefg") != 2 || EstimateTokens(strings.Repeat("x", 35)) != 10 {
		t.Fatal("estimate is not chars/3.5 rounded up")
	}
}

func TestBuildAddsSystemAndKeepsOrder(t *testing.T) {
	h := []store.Message{msg("1", "user", "hi"), msg("2", "assistant", "hello"), msg("3", "user", "bye")}
	r := Build("SYS", h, 8192, 0)
	if len(r.Messages) != 4 || r.Messages[0] != (Message{"system", "SYS"}) || r.Messages[3].Content != "bye" {
		t.Fatalf("unexpected messages: %+v", r.Messages)
	}
	if r.Dropped != 0 || r.FirstKeptID != "1" || r.PromptTokens <= 0 {
		t.Fatalf("unexpected result: %+v", r)
	}
}

func TestBuildLeavesOutReasoningAndFailedAnswers(t *testing.T) {
	answer := msg("2", "assistant", "the answer")
	answer.Reasoning = "secret thoughts"
	failed := store.Message{ID: "4", Role: "assistant", Status: store.StatusError, Error: "boom"}
	empty := store.Message{ID: "5", Role: "assistant", Status: store.StatusStopped}
	r := Build("SYS", []store.Message{msg("1", "user", "q"), answer, msg("3", "user", "q2"), failed, empty, msg("6", "user", "q3")}, 8192, 0)
	for _, m := range r.Messages {
		if strings.Contains(m.Content, "secret") || m.Content == "boom" {
			t.Fatalf("leaked %q", m.Content)
		}
	}
	if len(r.Messages) != 5 { // system, q, answer, q2, q3
		t.Fatalf("got %d messages: %+v", len(r.Messages), r.Messages)
	}
}

func TestBuildKeepsAStoppedPartialAnswer(t *testing.T) {
	partial := store.Message{ID: "2", Role: "assistant", Content: "half an ans", Status: store.StatusStopped}
	r := Build("S", []store.Message{msg("1", "user", "q"), partial, msg("3", "user", "go on")}, 8192, 0)
	if len(r.Messages) != 4 {
		t.Fatalf("partial answer should stay in the history: %+v", r.Messages)
	}
}

func TestBuildDropsOldestFirstAndRecordsTheCut(t *testing.T) {
	big := strings.Repeat("w", 350) // ~100 tokens + 8
	h := []store.Message{
		msg("1", "user", big), msg("2", "assistant", big),
		msg("3", "user", big), msg("4", "assistant", big),
		msg("5", "user", big),
	}
	// Context 400 → room 100, budget ≈ 283: two messages (216) fit, three (324) don't. Those two are an answer and
	// a question; the answer would lead, so it goes too and only the newest question stays.
	r := Build("S", h, 400, 0)
	if r.Dropped != 4 || r.FirstKeptID != "5" {
		t.Fatalf("unexpected cut: dropped=%d first=%s", r.Dropped, r.FirstKeptID)
	}
	if last := r.Messages[len(r.Messages)-1]; last.Content != big || r.Messages[0].Role != "system" {
		t.Fatal("system prompt and newest message must stay")
	}
}

func TestBuildNeverStartsWithAnAnswer(t *testing.T) {
	big := strings.Repeat("w", 350)
	h := []store.Message{msg("1", "user", big), msg("2", "assistant", "short"), msg("3", "user", big)}
	r := Build("S", h, 300, 0) // budget ≈ 208: fits the last two, so the short answer would lead
	if r.Messages[1].Role != "user" {
		t.Fatalf("history starts with %s", r.Messages[1].Role)
	}
	if r.Dropped != 2 || r.FirstKeptID != "3" {
		t.Fatalf("cut not recorded: %+v", r)
	}
}

func TestBuildAlwaysKeepsTheNewestMessage(t *testing.T) {
	huge := strings.Repeat("w", 100000)
	r := Build("S", []store.Message{msg("1", "user", "old"), msg("2", "assistant", "older"), msg("3", "user", huge)}, 400, 0)
	if r.Messages[len(r.Messages)-1].Content != huge || r.Dropped != 2 {
		t.Fatalf("newest message lost: dropped=%d", r.Dropped)
	}
}

func TestBuildExtraDropForTheRetry(t *testing.T) {
	h := []store.Message{
		msg("1", "user", "a"), msg("2", "assistant", "b"),
		msg("3", "user", "c"), msg("4", "assistant", "d"), msg("5", "user", "e"),
	}
	r := Build("S", h, 8192, 2)
	if r.Dropped != 2 || r.FirstKeptID != "3" {
		t.Fatalf("extra drop: %+v", r)
	}
	// Dropping more than exists still leaves the newest message.
	r = Build("S", h, 8192, 99)
	if len(r.Messages) != 2 || r.Messages[1].Content != "e" {
		t.Fatalf("over-drop: %+v", r.Messages)
	}
}

func TestBuildEmptyHistory(t *testing.T) {
	r := Build("S", nil, 8192, 0)
	if len(r.Messages) != 1 || r.FirstKeptID != "" || r.Dropped != 0 {
		t.Fatalf("unexpected: %+v", r)
	}
}

func TestContextSizesCachesPerBaseURL(t *testing.T) {
	var hits atomic.Int32
	srv := func(n int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/props" {
				http.NotFound(w, r)
				return
			}
			hits.Add(1)
			w.Write([]byte(`{"default_generation_settings":{"n_ctx":` + strconv.Itoa(n) + `}}`))
		}))
	}
	a, b := srv(4096), srv(16384)
	defer a.Close()
	defer b.Close()

	var c ContextSizes
	for range 3 {
		if n, err := c.Get(context.Background(), a.URL); err != nil || n != 4096 {
			t.Fatalf("a: %d %v", n, err)
		}
	}
	if n, err := c.Get(context.Background(), b.URL); err != nil || n != 16384 {
		t.Fatalf("b: %d %v", n, err)
	}
	if hits.Load() != 2 {
		t.Fatalf("asked the servers %d times, want 2 (cached per load)", hits.Load())
	}
}

func TestContextSizesErrors(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"status": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusServiceUnavailable) },
		"json":   func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("not json")) },
		"no n_ctx": func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"default_generation_settings":{}}`))
		},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(h)
			defer srv.Close()
			var c ContextSizes
			if _, err := c.Get(context.Background(), srv.URL); err == nil {
				t.Fatal("want an error")
			}
			// A failure must not be cached.
			if len(c.sizes) != 0 {
				t.Fatal("failure was cached")
			}
		})
	}
}
