package llamacpp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/provider"
)

var _ provider.Chat = (*Provider)(nil)

type wireMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type wireUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

type wireTimings struct {
	PredictedPerSecond float64 `json:"predicted_per_second"`
}

type wireToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chunk struct {
	Choices []struct {
		Delta struct {
			Content   string         `json:"content"`
			Reasoning string         `json:"reasoning_content"`
			ToolCalls []wireToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage   *wireUsage   `json:"usage"`
	Timings *wireTimings `json:"timings"`
	Error   *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// Complete streams one answer from llama-server. It holds the chat slot for req.Model until it returns, so the model
// is never swapped out mid-answer.
func (p *Provider) Complete(ctx context.Context, req provider.Request, emit func(provider.Delta)) (provider.Result, error) {
	msgs, err := wireMessages(req.Messages)
	if err != nil {
		return provider.Result{}, err
	}
	base, release, err := p.Acquire(ctx, provider.KindChat, req.Model)
	if err != nil {
		return provider.Result{}, err
	}
	defer release()

	body := map[string]any{
		"model": req.Model, "messages": msgs, "stream": true,
		"stream_options": map[string]bool{"include_usage": true},
	}
	if req.MaxOut > 0 {
		body["max_tokens"] = req.MaxOut
	}
	if req.Sampling.Temperature != nil {
		body["temperature"] = *req.Sampling.Temperature
	}
	if req.Sampling.TopP != nil {
		body["top_p"] = *req.Sampling.TopP
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{"type": "function", "function": map[string]any{
				"name": t.Name, "description": t.Description, "parameters": t.Parameters,
			}}
		}
		body["tools"] = tools
	}
	b, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(b))
	if err != nil {
		return provider.Result{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	s := &stream{sent: time.Now(), emit: emit}
	err = s.read(p.cfg.Client, httpReq)
	res := s.result()
	if ctx.Err() != nil {
		// Stop: what arrived so far is the answer. The request context closed the connection, so the server sees it.
		res.Stop = provider.StopCancelled
		return res, nil
	}
	return res, err
}

// wireMessages flattens messages to llama-server's role/content form. Reasoning is never sent back to the model.
func wireMessages(in []provider.Message) ([]wireMessage, error) {
	out := make([]wireMessage, len(in))
	for i, m := range in {
		var text strings.Builder
		for _, part := range m.Parts {
			switch part.Kind {
			case provider.PartText:
				text.WriteString(part.Text)
			case provider.PartReasoning:
			default:
				return nil, fmt.Errorf("unsupported part kind %d in message %d", part.Kind, i)
			}
		}
		out[i] = wireMessage{Role: m.Role, Content: text.String()}
	}
	return out, nil
}

// stream is one answer being read.
type stream struct {
	sent   time.Time
	emit   func(provider.Delta)
	parts  []provider.Part
	first  time.Time // first reasoning or text delta
	usage  *wireUsage
	tps    float64
	finish string
	calls  map[int]*provider.ToolCall
	args   map[int]*strings.Builder
}

func (s *stream) send(d provider.Delta) {
	if d.Kind != provider.PartToolCall && s.first.IsZero() {
		s.first = time.Now()
	}
	s.parts = provider.AppendDelta(s.parts, d)
	s.emit(d)
}

func (s *stream) read(client *http.Client, req *http.Request) error {
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if exceedsContext(b) {
			return provider.ErrContextExceeded
		}
		return fmt.Errorf("model server answered %d", resp.StatusCode)
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue // blank separators and comments
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			s.flushCalls()
			return nil
		}
		var c chunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			continue // a malformed line is not worth losing the answer over
		}
		if c.Error != nil {
			if exceedsContext([]byte(c.Error.Type + " " + c.Error.Message)) {
				return provider.ErrContextExceeded
			}
			return fmt.Errorf("model error: %s", c.Error.Message)
		}
		if c.Usage != nil {
			s.usage = c.Usage
		}
		if c.Timings != nil {
			s.tps = c.Timings.PredictedPerSecond
		}
		for _, ch := range c.Choices {
			if r := ch.Delta.Reasoning; r != "" {
				s.send(provider.Delta{Kind: provider.PartReasoning, Text: r})
			}
			if t := ch.Delta.Content; t != "" {
				s.send(provider.Delta{Kind: provider.PartText, Text: t})
			}
			for _, tc := range ch.Delta.ToolCalls {
				s.addCall(tc)
			}
			if ch.FinishReason != "" {
				s.finish = ch.FinishReason
			}
		}
	}
	// A cancelled request surfaces as a read error; Complete checks ctx to tell Stop from a failure.
	if err := sc.Err(); err != nil {
		return err
	}
	return errors.New("stream ended early")
}

// addCall folds one tool-call fragment into the call at its index.
func (s *stream) addCall(tc wireToolCall) {
	if s.calls == nil {
		s.calls, s.args = map[int]*provider.ToolCall{}, map[int]*strings.Builder{}
	}
	c, ok := s.calls[tc.Index]
	if !ok {
		c = &provider.ToolCall{}
		s.calls[tc.Index], s.args[tc.Index] = c, &strings.Builder{}
	}
	if c.ID == "" {
		c.ID = tc.ID
	}
	if c.Name == "" {
		c.Name = tc.Function.Name
	}
	s.args[tc.Index].WriteString(tc.Function.Arguments)
}

// flushCalls emits the assembled tool calls in index order.
func (s *stream) flushCalls() {
	idx := make([]int, 0, len(s.calls))
	for i := range s.calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		c := s.calls[i]
		c.Arguments = json.RawMessage(s.args[i].String())
		s.send(provider.Delta{Kind: provider.PartToolCall, Call: c})
	}
	s.calls = nil
}

func (s *stream) result() provider.Result {
	res := provider.Result{Parts: s.parts, Usage: provider.Usage{TokensPerSecond: s.tps}}
	if s.usage != nil {
		res.Usage.PromptTokens, res.Usage.AnswerTokens, res.Usage.Exact = s.usage.PromptTokens, s.usage.CompletionTokens, true
	}
	if !s.first.IsZero() {
		res.Usage.FirstTokenMs = s.first.Sub(s.sent).Milliseconds()
	}
	switch s.finish {
	case "tool_calls":
		res.Stop = provider.StopToolCalls
	case "length":
		res.Stop = provider.StopLength
	default:
		res.Stop = provider.StopEnd
	}
	return res
}

// exceedsContext recognises llama-server's "prompt is longer than the context" reply.
func exceedsContext(b []byte) bool {
	s := strings.ToLower(string(b))
	return strings.Contains(s, "exceed_context_size") || strings.Contains(s, "exceeds the available context")
}
