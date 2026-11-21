package event

import "encoding/json"

// ConfigChanged says a config section was written; Rev is the section's new revision.
type ConfigChanged struct {
	Section string `json:"section"`
	Rev     int    `json:"rev"`
}

func (ConfigChanged) EventType() Type { return Type{Name: "config.changed", V: 1, Class: Durable} }

// ModelState is the models list as GET /api/models shows it; Models is that JSON array.
type ModelState struct {
	Models json.RawMessage `json:"models"`
}

func (ModelState) EventType() Type { return Type{Name: "model.state", V: 1, Class: Retained} }

// DownloadProgress is the download queue; Items is the JSON array of its items.
type DownloadProgress struct {
	Items json.RawMessage `json:"items"`
}

func (DownloadProgress) EventType() Type {
	return Type{Name: "download.progress", V: 1, Class: Retained}
}

// ChatCreated starts a chat on chat:<id>; the chat's first run follows on its own stream.
type ChatCreated struct {
	Model   string `json:"model"`
	Profile string `json:"profile"`
}

func (ChatCreated) EventType() Type { return Type{Name: "chat.created", V: 1, Class: Durable} }

// ChatTitled names a chat. An auto title never replaces a user one.
type ChatTitled struct {
	Title  string `json:"title"`
	Source string `json:"source" enum:"auto,user"`
}

func (ChatTitled) EventType() Type { return Type{Name: "chat.titled", V: 1, Class: Durable} }

// ChatModel is the model the chat's next run uses.
type ChatModel struct {
	Model string `json:"model"`
}

func (ChatModel) EventType() Type { return Type{Name: "chat.model", V: 1, Class: Durable} }

// TurnRetracted hides a run's messages from the transcript and the context; the log stays append-only.
type TurnRetracted struct {
	RunID string `json:"runId"`
}

func (TurnRetracted) EventType() Type { return Type{Name: "turn.retracted", V: 1, Class: Durable} }

// ChatDeleted goes on system after a chat's own and its runs' events are deleted, so lists drop the chat.
type ChatDeleted struct {
	ChatID string `json:"chatId"`
}

func (ChatDeleted) EventType() Type { return Type{Name: "chat.deleted", V: 1, Class: Durable} }

// RunQueued opens a run on run:<id>. RequestID is the client's retry key for the send that made it.
type RunQueued struct {
	ChatID    string `json:"chatId"`
	Profile   string `json:"profile"`
	Model     string `json:"model"`
	Origin    string `json:"origin" enum:"user"`
	RequestID string `json:"requestId"`
}

func (RunQueued) EventType() Type { return Type{Name: "run.queued", V: 1, Class: Durable} }

// InputReceived is the user's text for a run; RequestID makes a repeated send write nothing.
type InputReceived struct {
	ChatID    string `json:"chatId"`
	Text      string `json:"text"`
	RequestID string `json:"requestId"`
}

func (InputReceived) EventType() Type { return Type{Name: "input.received", V: 1, Class: Durable} }

// RunStarted says the run holds its lease and is working.
type RunStarted struct {
	ChatID string `json:"chatId"`
}

func (RunStarted) EventType() Type { return Type{Name: "run.started", V: 1, Class: Durable} }

// RunPaused says the run stopped working without finishing; it waits to be resumed.
type RunPaused struct {
	ChatID string `json:"chatId"`
	Reason string `json:"reason" enum:"interrupted"`
}

func (RunPaused) EventType() Type { return Type{Name: "run.paused", V: 1, Class: Durable} }

// RunResumed puts a paused run back in the queue.
type RunResumed struct {
	ChatID string `json:"chatId"`
}

func (RunResumed) EventType() Type { return Type{Name: "run.resumed", V: 1, Class: Durable} }

// RunError is why a run failed, with one of core's error codes.
type RunError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// RunFinished ends a run; Error is set only when State is failed.
type RunFinished struct {
	ChatID string    `json:"chatId"`
	State  string    `json:"state" enum:"done,stopped,failed"`
	Error  *RunError `json:"error,omitempty"`
}

func (RunFinished) EventType() Type { return Type{Name: "run.finished", V: 1, Class: Durable} }

// MessageDelta is a piece of the answer; N numbers the run's deltas from 1.
type MessageDelta struct {
	Text string `json:"text"`
	N    int    `json:"n"`
}

func (MessageDelta) EventType() Type { return Type{Name: "message.delta", V: 1, Class: Ephemeral} }

// ReasoningDelta is a piece of the model's reasoning, numbered with the message deltas.
type ReasoningDelta struct {
	Text string `json:"text"`
	N    int    `json:"n"`
}

func (ReasoningDelta) EventType() Type { return Type{Name: "reasoning.delta", V: 1, Class: Ephemeral} }

// MessagePartial is the answer so far, sent to a client attaching mid-answer; it holds the deltas up to N.
type MessagePartial struct {
	Text      string `json:"text"`
	Reasoning string `json:"reasoning"`
	N         int    `json:"n"`
}

func (MessagePartial) EventType() Type { return Type{Name: "message.partial", V: 1, Class: Ephemeral} }

// MessagePart is one part of a stored message.
type MessagePart struct {
	Kind string `json:"kind" enum:"text,reasoning"`
	Text string `json:"text"`
}

// MessageStats is the provider's usage plus the run's timing; Exact is false when the counts are estimated.
type MessageStats struct {
	PromptTokens    int     `json:"promptTokens"`
	AnswerTokens    int     `json:"answerTokens"`
	Exact           bool    `json:"exact"`
	TokensPerSecond float64 `json:"tokensPerSecond"`
	FirstTokenMs    int64   `json:"firstTokenMs"`
	ReasoningMs     int64   `json:"reasoningMs"`
	DurationMs      int64   `json:"durationMs"`
	ContextSize     int     `json:"contextSize"`
}

// MessageCompleted stores an answer. Partial means the text stopped early (stop, or failure mid-answer).
type MessageCompleted struct {
	ChatID  string        `json:"chatId"`
	Parts   []MessagePart `json:"parts"`
	Partial bool          `json:"partial"`
	Model   string        `json:"model"`
	Stats   MessageStats  `json:"stats"`
}

func (MessageCompleted) EventType() Type {
	return Type{Name: "message.completed", V: 1, Class: Durable}
}

// CompactionCompleted replaces the messages before FirstKeptSeq with Summary in the run's context.
type CompactionCompleted struct {
	ChatID       string `json:"chatId"`
	Summary      string `json:"summary"`
	FirstKeptSeq int64  `json:"firstKeptSeq"`
	TokensBefore int    `json:"tokensBefore"`
	TokensAfter  int    `json:"tokensAfter"`
}

func (CompactionCompleted) EventType() Type {
	return Type{Name: "compaction.completed", V: 1, Class: Durable}
}

// SchedWaiting is a run waiting for the lease and why.
type SchedWaiting struct {
	RunID string `json:"runId"`
	Why   string `json:"why"`
}

// SchedState is who holds the scheduler's lease and who waits for it.
type SchedState struct {
	Holder  string         `json:"holder,omitempty"`
	Waiting []SchedWaiting `json:"waiting"`
}

func (SchedState) EventType() Type { return Type{Name: "sched.state", V: 1, Class: Retained} }

// Types lists every payload type. A new type is added here and to api's eventDocs (a test checks both).
var Types = []Payload{
	ConfigChanged{}, ModelState{}, DownloadProgress{},
	ChatCreated{}, ChatTitled{}, ChatModel{}, TurnRetracted{}, ChatDeleted{},
	RunQueued{}, InputReceived{}, RunStarted{}, RunPaused{}, RunResumed{}, RunFinished{},
	MessageDelta{}, ReasoningDelta{}, MessagePartial{}, MessageCompleted{}, CompactionCompleted{},
	SchedState{},
}
