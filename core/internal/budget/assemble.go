package budget

import (
	"errors"
	"fmt"
	"strings"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/provider"
)

// Message is one row of the conversation in the order the model reads it.
type Message struct {
	Seq               int64
	Role              string // "user" | "assistant" | "tool"
	Parts             []event.MessagePart
	Failed, Retracted bool
}

// Summary is the latest compaction of the conversation's start.
type Summary struct {
	Text         string
	FirstKeptSeq int64
	Seq          int64 // the compaction.completed event's seq
}

// Known is the exact prompt size the provider reported for the answer at Seq; zero = none.
type Known struct {
	PromptTokens int
	Seq          int64
}

// Input is everything Assemble plans from.
type Input struct {
	Model, CacheKey string
	Fixed           string    // the profile's system prompt, date filled in
	FixedTokens     int       // exact count of Fixed; 0 = estimate it
	Summary         *Summary  // latest compaction, if any
	Messages        []Message // from the summary's first kept message on; a last "user" message is the input being answered
	Known           Known
	PruneTo         int64 // tool messages with Seq <= PruneTo are sent as stubs
	Force           bool  // plan as if over Trigger: the retry after the provider said the prompt is too long
}

// Verdict is what the caller does next.
type Verdict int

const (
	Send Verdict = iota
	Prune
	Compact
	Refuse
)

// Plan is the outcome of Assemble.
type Plan struct {
	Verdict Verdict
	Request provider.Request // Send: Model, CacheKey and Messages (system first); other verdicts: zero
	Tokens  int              // expected prompt size; set for every verdict
	CutAt   int64            // Prune: stub tool messages up to this seq; Compact: first kept message's seq
	Err     error            // Refuse: ErrContextTooSmall or ErrMessageTooLong
}

var (
	ErrContextTooSmall = errors.New("context too small")
	ErrMessageTooLong  = errors.New("message too long")
)

const summaryHeading = "\n\nSummary of the earlier conversation:\n"

// sentText is the text of m as the model reads it, and false when m is never sent: retracted and failed messages
// and assistant messages without text. Reasoning is never sent.
func sentText(m Message) (string, bool) {
	if m.Retracted || m.Failed {
		return "", false
	}
	var b strings.Builder
	for _, p := range m.Parts {
		if p.Kind == "text" {
			b.WriteString(p.Text)
		}
	}
	if m.Role == "assistant" && b.Len() == 0 {
		return "", false
	}
	return b.String(), true
}

// capTool keeps the first and last toolCap/2 tokens' worth of a long tool result.
func capTool(text string, toolCap int) string {
	est := EstimateTokens(text)
	if est <= toolCap {
		return text
	}
	half := toolCap / 2
	runes := []rune(text)
	n := min(int(float64(half)*charsPerToken), len(runes)/2)
	return string(runes[:n]) + fmt.Sprintf("\n[… %d tokens left out …]\n", max(est-2*half, 0)) + string(runes[len(runes)-n:])
}

type sentMsg struct {
	seq  int64
	role string
	text string
	cost int
}

// Assemble plans one prompt: send it, prune old tool results, compact the start, or refuse.
func Assemble(in Input, w Window) Plan {
	system := in.Fixed
	summaryCost := 0
	if in.Summary != nil {
		add := summaryHeading + in.Summary.Text
		system += add
		summaryCost = EstimateTokens(add)
	}
	fixedCost := in.FixedTokens
	if fixedCost == 0 {
		fixedCost = EstimateTokens(in.Fixed)
	}
	fixedCost += perMessageTokens

	sent := make([]sentMsg, 0, len(in.Messages))
	index := map[int64]int{} // seq → position in sent
	costOf := map[int]int{}  // position in in.Messages → cost, 0 when not sent
	for i, m := range in.Messages {
		text, ok := sentText(m)
		if !ok {
			continue
		}
		if m.Role == "tool" {
			if m.Seq <= in.PruneTo {
				text = fmt.Sprintf("[result removed, %d tokens]", EstimateTokens(text))
			} else {
				text = capTool(text, w.ToolCap)
			}
		}
		c := EstimateTokens(text) + perMessageTokens
		index[m.Seq] = len(sent)
		costOf[i] = c
		sent = append(sent, sentMsg{m.Seq, m.Role, text, c})
	}

	tokens := fixedCost + summaryCost
	for _, s := range sent {
		tokens += s.cost
	}
	if in.Known.Seq != 0 && (in.Summary == nil || in.Known.Seq > in.Summary.Seq) {
		if at, ok := index[in.Known.Seq]; ok {
			tokens = in.Known.PromptTokens
			for _, s := range sent[at:] {
				tokens += s.cost
			}
		}
	}

	plan := Plan{Tokens: tokens}
	if fixedCost > w.Room/2 {
		plan.Verdict, plan.Err = Refuse, ErrContextTooSmall
		return plan
	}
	if n := len(in.Messages); n > 0 && in.Messages[n-1].Role == "user" && costOf[n-1] > w.Room-fixedCost {
		plan.Verdict, plan.Err = Refuse, ErrMessageTooLong
		return plan
	}

	send := func() Plan {
		msgs := make([]provider.Message, 0, len(sent)+1)
		msgs = append(msgs, provider.TextMessage("system", system))
		for _, s := range sent {
			msgs = append(msgs, provider.TextMessage(s.role, s.text))
		}
		plan.Verdict = Send
		plan.Request = provider.Request{Model: in.Model, CacheKey: in.CacheKey, Messages: msgs}
		return plan
	}
	if tokens <= w.Trigger && !in.Force {
		return send()
	}

	// Prune: the oldest tool results go first, but the two newest stay readable.
	var tools []int
	for i, m := range in.Messages {
		if m.Role == "tool" && !m.Retracted && !m.Failed {
			tools = append(tools, i)
		}
	}
	for j := len(tools) - 3; j >= 0; j-- {
		if m := in.Messages[tools[j]]; m.Seq > in.PruneTo {
			plan.Verdict, plan.CutAt = Prune, m.Seq
			return plan
		}
	}

	// Compact: keep the newest turns that fit the target, and at least the last two.
	var starts []int // positions in Messages where a turn begins; the first turn also owns leading non-user messages
	seenUser := false
	for i, m := range in.Messages {
		isUser := m.Role == "user"
		if i == 0 || isUser && (seenUser || in.Messages[0].Role == "user") {
			starts = append(starts, i)
		}
		seenUser = seenUser || isUser
	}
	if len(starts) == 0 {
		return send()
	}
	kept := len(starts) - 1 // turn index the kept part starts at
	used := fixedCost
	end := len(in.Messages)
	for t := len(starts) - 1; t >= 0; t-- {
		turn := 0
		for i := starts[t]; i < end; i++ {
			turn += costOf[i]
		}
		if used+turn > w.Target && len(starts)-t > 2 {
			break
		}
		used += turn
		kept = t
		end = starts[t]
	}
	if kept == 0 {
		return send()
	}
	plan.Verdict, plan.CutAt = Compact, in.Messages[starts[kept]].Seq
	return plan
}
