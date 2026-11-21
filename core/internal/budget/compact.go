package budget

import (
	"strings"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/provider"
)

const cutMark = "[…]"

// SummaryMax is the most tokens a summary may take: min(w.AnswerRoom, w.Target/2).
func SummaryMax(w Window) int {
	return min(w.AnswerRoom, w.Target/2)
}

// line renders a message for the compaction prompt; false when Assemble would not send it.
func line(m Message) (string, bool) {
	text, ok := sentText(m)
	if !ok {
		return "", false
	}
	label := "Tool"
	switch m.Role {
	case "user":
		label = "User"
	case "assistant":
		label = "Assistant"
	}
	return label + ": " + text, true
}

// Pieces splits msgs (everything before CutAt, in Messages order) into pieces that each fit one compaction call,
// oldest first. systemTokens is the compaction profile's prompt, estimated by the caller.
func Pieces(msgs []Message, w Window, systemTokens int) [][]Message {
	limit := max(w.Room-systemTokens-2*SummaryMax(w)-2*perMessageTokens, 1)
	var pieces [][]Message
	var cur []Message
	used := 0
	flush := func() {
		if len(cur) > 0 {
			pieces = append(pieces, cur)
			cur, used = nil, 0
		}
	}
	for _, m := range msgs {
		l, ok := line(m)
		if !ok {
			continue
		}
		cost := EstimateTokens(l)
		if cost > limit {
			// Cut at a rune boundary; the label stays, the text ends with the mark.
			keep := max(int(float64(limit)*charsPerToken)-len([]rune(cutMark)), 0)
			text, _ := sentText(m)
			prefix := len([]rune(l)) - len([]rune(text))
			runes := []rune(text)
			m.Parts = []event.MessagePart{{Kind: "text", Text: string(runes[:max(min(keep-prefix, len(runes)), 0)]) + cutMark}}
			cost = limit
		}
		if used+cost > limit {
			flush()
		}
		cur = append(cur, m)
		used += cost
	}
	flush()
	return pieces
}

// CompactRequest is one compaction call: the previous summary ("" = none) and one piece.
func CompactRequest(model, system, prev string, piece []Message, w Window) provider.Request {
	if prev == "" {
		prev = "none"
	}
	var lines []string
	for _, m := range piece {
		if l, ok := line(m); ok {
			lines = append(lines, l)
		}
	}
	user := "Previous summary:\n" + prev + "\n\nConversation to summarise:\n" + strings.Join(lines, "\n\n") + "\n\nWrite the new summary."
	return provider.Request{
		Model:      model,
		Messages:   []provider.Message{provider.TextMessage("system", system), provider.TextMessage("user", user)},
		MaxOut:     SummaryMax(w),
		NoThinking: true,
	}
}
