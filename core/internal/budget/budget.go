// Package budget decides what of a conversation goes into the prompt so it fits the model's context: Assemble plans
// one prompt (send, prune, compact or refuse) and the compaction helpers summarise the conversation's start.
package budget

import (
	"unicode/utf8"
)

const (
	// charsPerToken is a rough average for English and code. Being a little pessimistic is safe because the run
	// compacts and retries once if the server still says the prompt doesn't fit.
	charsPerToken = 3.5
	// maxAnswerRoom caps the space kept free for the answer, however large the context is.
	maxAnswerRoom = 4096
	// perMessageTokens covers the role markers a chat template adds around each message.
	perMessageTokens = 8
)

// EstimateTokens guesses the token count of a text as characters ÷ 3.5, rounded up.
func EstimateTokens(s string) int {
	return int(float64(utf8.RuneCountInString(s))/charsPerToken + 0.999999)
}
