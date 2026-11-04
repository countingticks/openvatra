// Package prompt turns a stored conversation into the message list sent to the model: it adds the system prompt,
// leaves out earlier reasoning and drops the oldest turns when the conversation no longer fits the model's context.
package prompt

import (
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/countingticks/openvatra/core/internal/store"
)

// Message is one entry of an OpenAI-style chat request.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

const (
	// charsPerToken is a rough average for English and code. Core has no tokenizer; being a little pessimistic
	// is safe because the request is retried with fewer turns if the server still says it doesn't fit.
	charsPerToken = 3.5
	// maxAnswerRoom caps the space kept free for the answer, however large the context is.
	maxAnswerRoom = 4096
	// perMessageTokens covers the role markers a chat template adds around each message.
	perMessageTokens = 8
)

// SystemPrompt is the default system prompt. The date lets a model answer "what day is it" and judge web results.
func SystemPrompt(now time.Time) string {
	return fmt.Sprintf("You are a helpful assistant running on the user's own computer. Today is %s.",
		now.Format("Monday, 2 January 2006"))
}

// EstimateTokens guesses the token count of a text as characters ÷ 3.5, rounded up.
func EstimateTokens(s string) int {
	return int(float64(utf8.RuneCountInString(s))/charsPerToken + 0.999999)
}

// AnswerRoom is the space kept free for the answer: a quarter of the context, at most 4 k tokens.
func AnswerRoom(contextSize int) int {
	return min(contextSize/4, maxAnswerRoom)
}

// Result is a finished prompt.
type Result struct {
	Messages []Message
	// FirstKeptID is the id of the oldest stored message that was sent; "" when there was no history at all.
	FirstKeptID string
	// Dropped is how many of the oldest history messages were left out. The UI draws its "older messages no
	// longer fit" line before FirstKeptID when this is above zero.
	Dropped int
	// PromptTokens is the estimate for what is sent, system prompt included.
	PromptTokens int
}

// Build makes the request messages from the stored history (oldest first, already including the new user message
// as its last entry). system is the system prompt text; contextSize is the model's context in tokens.
//
// Rules: reasoning is never sent back; failed answers and empty ones are skipped; the newest message is always kept
// (if even that is too big the server reports it and the user sees "This message is too long"); older turns are
// dropped oldest first, in pairs where possible so history never starts with an answer nobody asked for. extraDrop
// removes that many more messages after fitting, for the retry when the server still says the context is exceeded.
func Build(system string, history []store.Message, contextSize, extraDrop int) Result {
	usable := make([]store.Message, 0, len(history))
	for _, m := range history {
		if m.Status == store.StatusError || (m.Content == "" && m.Role == store.RoleAssistant) {
			continue
		}
		usable = append(usable, m)
	}

	budget := contextSize - AnswerRoom(contextSize) - EstimateTokens(system) - perMessageTokens
	cost := func(m store.Message) int { return EstimateTokens(m.Content) + perMessageTokens }

	// Walk from the newest message backwards, keeping while it fits.
	start := len(usable)
	used := 0
	for i := len(usable) - 1; i >= 0; i-- {
		c := cost(usable[i])
		if used+c > budget && start < len(usable) { // the newest message is always kept
			break
		}
		used += c
		start = i
	}
	start = min(start+extraDrop, max(len(usable)-1, 0))
	// A conversation should open with the user's turn; skip a leading answer whose question was cut.
	for start < len(usable)-1 && usable[start].Role == store.RoleAssistant {
		start++
	}

	kept := usable[start:]
	res := Result{Messages: make([]Message, 0, len(kept)+1), Dropped: start}
	res.Messages = append(res.Messages, Message{Role: "system", Content: system})
	res.PromptTokens = EstimateTokens(system) + perMessageTokens
	for _, m := range kept {
		res.Messages = append(res.Messages, Message{Role: m.Role, Content: m.Content})
		res.PromptTokens += cost(m)
	}
	if len(kept) > 0 {
		res.FirstKeptID = kept[0].ID
	}
	return res
}
