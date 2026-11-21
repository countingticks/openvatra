// Package budget decides what of a conversation goes into the prompt so it fits the model's context. This is the
// first cut, Fit: estimated token counts and dropping the oldest turns. Assemble (assemble.go) replaces it in 066.
package budget

import (
	"unicode/utf8"

	"github.com/countingticks/openvatra/core/internal/provider"
)

const (
	// charsPerToken is a rough average for English and code. Being a little pessimistic is safe because the run
	// retries with fewer turns if the server still says the prompt doesn't fit.
	charsPerToken = 3.5
	// maxAnswerRoom caps the space kept free for the answer, however large the context is.
	maxAnswerRoom = 4096
	// perMessageTokens covers the role markers a chat template adds around each message.
	perMessageTokens = 8
)

// Turn is one message of the conversation, already filtered by the caller (no reasoning, no failed answers).
type Turn struct {
	Role string // "user" | "assistant"
	Text string
}

// Result is a finished prompt.
type Result struct {
	Messages     []provider.Message // system first
	PromptTokens int                // the estimate for what is sent, system prompt included
	Dropped      int                // how many of the oldest turns were left out
}

// EstimateTokens guesses the token count of a text as characters ÷ 3.5, rounded up.
func EstimateTokens(s string) int {
	return int(float64(utf8.RuneCountInString(s))/charsPerToken + 0.999999)
}

// AnswerRoom is the space kept free for the answer: a quarter of the context, at most 4 k tokens.
func AnswerRoom(contextSize int) int {
	return min(contextSize/4, maxAnswerRoom)
}

// Fit makes the request messages from turns (oldest first, the newest being the input to answer).
//
// The newest turn is always kept (if even that is too big the server says so and the run fails with
// context_too_small); older turns are dropped oldest first; a turn left leading with an answer nobody asked for is
// dropped too. extraDrop removes that many more of the oldest kept turns, for the retry when the server still says
// the context is exceeded.
func Fit(system string, turns []Turn, contextSize, extraDrop int) Result {
	budget := contextSize - AnswerRoom(contextSize) - EstimateTokens(system) - perMessageTokens
	cost := func(t Turn) int { return EstimateTokens(t.Text) + perMessageTokens }

	// Walk from the newest turn backwards, keeping while it fits.
	start := len(turns)
	used := 0
	for i := len(turns) - 1; i >= 0; i-- {
		c := cost(turns[i])
		if used+c > budget && start < len(turns) { // the newest turn is always kept
			break
		}
		used += c
		start = i
	}
	start = min(start+extraDrop, max(len(turns)-1, 0))
	// A conversation should open with the user's turn; skip a leading answer whose question was cut.
	for start < len(turns)-1 && turns[start].Role == "assistant" {
		start++
	}

	kept := turns[start:]
	res := Result{Messages: make([]provider.Message, 0, len(kept)+1), Dropped: start}
	res.Messages = append(res.Messages, provider.TextMessage("system", system))
	res.PromptTokens = EstimateTokens(system) + perMessageTokens
	for _, t := range kept {
		res.Messages = append(res.Messages, provider.TextMessage(t.Role, t.Text))
		res.PromptTokens += cost(t)
	}
	return res
}
