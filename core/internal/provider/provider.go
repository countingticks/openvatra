// Package provider is the seam between core and whatever runs language models: the interfaces a provider
// implements, the shapes that cross it and its errors.
package provider

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/countingticks/openvatra/core/internal/seam"
)

// Provider is what every provider is: it describes itself and lists its models.
type Provider interface {
	seam.Described
	Models(ctx context.Context) ([]Model, error)
}

const (
	ModelChat      = "chat"
	ModelEmbedding = "embedding"
)

// Model is one model a provider can run.
type Model struct {
	ID        string
	Kind      string // ModelChat or ModelEmbedding
	Context   int    // tokens the model loads with; 0 when not known before loading
	Vision    bool
	ToolCalls bool // false for llama.cpp until Step 6
}

// Chat is a provider that completes chats.
type Chat interface {
	Complete(ctx context.Context, req Request, emit func(Delta)) (Result, error)
}

// Embedder is a provider that embeds text.
type Embedder interface {
	Embed(ctx context.Context, model string, texts []string) ([][]float32, error)
}

// Counter is a provider that counts tokens.
type Counter interface {
	Count(ctx context.Context, model string, text string) (int, error)
}

// Resident is a provider that keeps models loaded and can show and change which.
type Resident interface {
	States() []ModelState
	Load(ctx context.Context, id string) error
	Unload(id string) bool
	Subscribe() (<-chan struct{}, func())
	Notify()
}

// Kind picks the slot an Upstream request uses.
type Kind int

const (
	KindChat Kind = iota
	KindEmbedding
)

// Upstream is a provider with an OpenAI-compatible server the /v1 proxy forwards to unchanged.
type Upstream interface {
	Acquire(ctx context.Context, kind Kind, model string) (baseURL string, release func(), err error)
}

type Request struct {
	Model    string
	Messages []Message
	Tools    []ToolSchema // empty: no tools offered
	Sampling Sampling
	MaxOut   int    // 0 = the provider's default
	CacheKey string // ignored by llamacpp in this step
}

type Message struct {
	Role  string // "system", "user", "assistant", "tool"
	Parts []Part
}

// TextMessage is a message of one text part.
func TextMessage(role, text string) Message {
	return Message{Role: role, Parts: []Part{{Kind: PartText, Text: text}}}
}

type PartKind int

const (
	PartText PartKind = iota
	PartReasoning
	PartImage
	PartToolCall
	PartToolResult
)

type Part struct {
	Kind PartKind
	Text string
	Call *ToolCall // PartToolCall; PartToolResult carries the call's ID here
	Ref  string    // PartImage: image or file reference
}

type ToolCall struct {
	ID        string
	Name      string
	Arguments json.RawMessage
}

type ToolSchema struct {
	Name        string
	Description string
	Parameters  json.RawMessage // JSON Schema
}

// Sampling: nil means the provider's default.
type Sampling struct{ Temperature, TopP *float64 }

type Delta struct {
	Kind PartKind // PartText, PartReasoning or PartToolCall
	Text string
	Call *ToolCall
}

type Usage struct {
	PromptTokens, AnswerTokens int
	Exact                      bool    // false: the provider sent no counts, both are 0 and the caller estimates
	TokensPerSecond            float64 // 0 = not reported
	FirstTokenMs               int64
}

type Stop int

const (
	StopEnd Stop = iota
	StopToolCalls
	StopLength
	StopCancelled
)

type Result struct {
	Parts []Part
	Usage Usage
	Stop  Stop
}

// AppendDelta adds d to parts the way a provider builds Result.Parts from its deltas.
func AppendDelta(parts []Part, d Delta) []Part {
	if d.Text == "" && d.Call == nil {
		return parts
	}
	if d.Kind == PartToolCall {
		return append(parts, Part{Kind: PartToolCall, Call: d.Call})
	}
	if n := len(parts); n > 0 && parts[n-1].Kind == d.Kind {
		parts[n-1].Text += d.Text
		return parts
	}
	return append(parts, Part{Kind: d.Kind, Text: d.Text})
}

var (
	// ErrUnknownModel means no model with that id exists on disk.
	ErrUnknownModel = errors.New("unknown model")
	// ErrNoEmbeddingModel means no embedding model has been chosen yet.
	ErrNoEmbeddingModel = errors.New("no embedding model chosen")
	ErrContextExceeded  = errors.New("context exceeded")
)

// LoadError says loading a model failed.
type LoadError struct {
	Model string
	Err   error
}

func (e *LoadError) Error() string { return "load " + e.Model + ": " + e.Err.Error() }
func (e *LoadError) Unwrap() error { return e.Err }

// Model states a Resident reports. "stopped" is left to the caller: a provider only knows the models it has touched.
const (
	StateLoading = "loading"
	StateReady   = "ready"
	StateError   = "error"
)

// ModelState is what a Resident knows about one model.
type ModelState struct {
	ID    string `json:"id"`
	State string `json:"state" enum:"stopped,loading,ready,error"`
	Busy  bool   `json:"busy"`
	Error string `json:"error,omitempty"`
}
