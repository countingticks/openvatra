package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/chats"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/run"
	"github.com/countingticks/openvatra/core/internal/store"
)

type StartRun struct {
	RequestID string `json:"requestId" doc:"the client's id for this send; the same id again answers the same run"`
	ChatID    string `json:"chatId,omitempty" doc:"omit to start a new chat"`
	Model     string `json:"model,omitempty" doc:"omit for the chat's model, or for a new chat the last one named"`
	Text      string `json:"text"`
}

type RunRef struct {
	RunID  string `json:"runId"`
	ChatID string `json:"chatId"`
	Seq    int64  `json:"seq" doc:"read the run's events on /api/events from after this seq"`
}

type RunPath struct {
	ID string `path:"id"`
}

type RunSnapshot struct {
	ID      string          `json:"id"`
	ChatID  string          `json:"chatId"`
	State   string          `json:"state" enum:"queued,running,interrupted,done,stopped,failed"`
	Profile string          `json:"profile"`
	Model   string          `json:"model"`
	Error   *event.RunError `json:"error,omitempty"`
	Seq     int64           `json:"seq"`
}

type ChatPath struct {
	ID string `path:"id"`
}

type ActiveRun struct {
	ID    string `json:"id"`
	State string `json:"state" enum:"queued,running,interrupted"`
}

type ChatItem struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Model     string     `json:"model"`
	UpdatedAt int64      `json:"updatedAt" doc:"Unix ms"`
	ActiveRun *ActiveRun `json:"activeRun,omitempty"`
}

type ChatList struct {
	Seq   int64      `json:"seq"`
	Chats []ChatItem `json:"chats"`
}

type ChatBody struct {
	Seq  int64    `json:"seq"`
	Chat ChatItem `json:"chat"`
}

type TranscriptItem struct {
	Seq     int64               `json:"seq"`
	Kind    string              `json:"kind" enum:"input,answer,summary"`
	RunID   string              `json:"runId"`
	Text    string              `json:"text,omitempty" doc:"input and summary"`
	Parts   []event.MessagePart `json:"parts,omitempty" doc:"answer"`
	Stats   *event.MessageStats `json:"stats,omitempty" doc:"answer"`
	Partial bool                `json:"partial,omitempty" doc:"the answer was cut off by a stop or a failure"`
	Failed  bool                `json:"failed,omitempty"`
}

type ContextUse struct {
	Used int `json:"used"`
	Size int `json:"size" doc:"0 when the chat's model is not installed"`
}

type Transcript struct {
	Seq       int64            `json:"seq"`
	Items     []TranscriptItem `json:"items"`
	Runs      []RunSnapshot    `json:"runs"`
	ActiveRun *RunSnapshot     `json:"activeRun,omitempty"`
	Context   ContextUse       `json:"context"`
}

type UpdateChat struct {
	ID    string  `path:"id"`
	Title *string `json:"title,omitempty"`
	Model *string `json:"model,omitempty"`
}

// runRoutes are the run and chat endpoints. Without a database each one answers 503, instead of not existing.
func runRoutes(svc *chats.Service, engine *run.Engine) []Route {
	ready := func() error {
		if svc == nil || engine == nil {
			return event.ErrUnavailable
		}
		return nil
	}

	return []Route{
		JSON(http.MethodPost, "/api/runs", UI, "startRun", "Send a message: to a new chat, or to a chat by id",
			func(ctx context.Context, in StartRun) (RunRef, error) {
				if err := ready(); err != nil {
					return RunRef{}, err
				}
				ref, err := svc.Send(ctx, chats.SendInput{RequestID: in.RequestID, ChatID: in.ChatID, Model: in.Model,
					Text: in.Text})
				return RunRef{RunID: ref.RunID, ChatID: ref.ChatID, Seq: ref.Seq}, err
			}).
			WithStatus(http.StatusAccepted).
			WithErrors("invalid_request", "bad_request", "chat_not_found", "model_not_found", "no_chat_model",
				"chat_unavailable"),
		JSON(http.MethodGet, "/api/runs/{id}", UI, "getRun", "One run's state",
			func(ctx context.Context, in RunPath) (RunSnapshot, error) {
				if err := ready(); err != nil {
					return RunSnapshot{}, err
				}
				row, seq, err := svc.Run(ctx, in.ID)
				return runSnapshot(row, seq), err
			}).
			WithErrors("run_not_found", "chat_unavailable"),
		JSON(http.MethodPost, "/api/runs/{id}/stop", UI, "stopRun", "Stop a run, keeping the answer so far",
			func(ctx context.Context, in RunPath) (NoContent, error) {
				if err := ready(); err != nil {
					return NoContent{}, err
				}
				return NoContent{}, engine.Stop(ctx, in.ID)
			}).
			WithErrors("run_not_found", "chat_unavailable"),
		JSON(http.MethodPost, "/api/runs/{id}/resume", UI, "resumeRun", "Continue a run that a restart cut off",
			func(ctx context.Context, in RunPath) (NoContent, error) {
				if err := ready(); err != nil {
					return NoContent{}, err
				}
				return NoContent{}, engine.Resume(ctx, in.ID)
			}).
			WithErrors("run_not_found", "run_not_interrupted", "chat_unavailable"),

		JSON(http.MethodGet, "/api/chats", UI, "listChats", "List the chats, most recently updated first",
			func(ctx context.Context, _ struct{}) (ChatList, error) {
				if err := ready(); err != nil {
					return ChatList{}, err
				}
				rows, seq, err := svc.List(ctx)
				if err != nil {
					return ChatList{}, err
				}
				items := make([]ChatItem, 0, len(rows))
				for _, c := range rows {
					items = append(items, chatItem(c))
				}
				return ChatList{Seq: seq, Chats: items}, nil
			}).
			WithErrors("chat_unavailable"),
		JSON(http.MethodGet, "/api/chats/{id}", UI, "getChat", "One chat",
			func(ctx context.Context, in ChatPath) (ChatBody, error) {
				if err := ready(); err != nil {
					return ChatBody{}, err
				}
				c, seq, err := svc.Get(ctx, in.ID)
				return ChatBody{Seq: seq, Chat: chatItem(c)}, err
			}).
			WithErrors("chat_not_found", "chat_unavailable"),
		JSON(http.MethodGet, "/api/chats/{id}/messages", UI, "getTranscript", "A chat's messages and runs, oldest first",
			func(ctx context.Context, in ChatPath) (Transcript, error) {
				if err := ready(); err != nil {
					return Transcript{}, err
				}
				msgs, runs, seq, err := svc.Transcript(ctx, in.ID)
				if err != nil {
					return Transcript{}, err
				}
				out, err := transcript(msgs, runs, seq)
				if err != nil {
					return Transcript{}, err
				}
				if out.Context.Used, out.Context.Size, err = svc.Context(ctx, in.ID); err != nil {
					return Transcript{}, err
				}
				return out, nil
			}).
			WithErrors("chat_not_found", "chat_unavailable"),
		JSON(http.MethodPatch, "/api/chats/{id}", UI, "updateChat", "Rename a chat or change its model",
			func(ctx context.Context, in UpdateChat) (ChatBody, error) {
				if err := ready(); err != nil {
					return ChatBody{}, err
				}
				c, seq, err := svc.Update(ctx, in.ID, in.Title, in.Model)
				return ChatBody{Seq: seq, Chat: chatItem(c)}, err
			}).
			WithErrors("invalid_request", "bad_request", "chat_not_found", "model_not_found", "chat_unavailable"),
		JSON(http.MethodDelete, "/api/chats/{id}", UI, "deleteChat", "Delete a chat, stopping its answer first",
			func(ctx context.Context, in ChatPath) (NoContent, error) {
				if err := ready(); err != nil {
					return NoContent{}, err
				}
				return NoContent{}, svc.Delete(ctx, in.ID)
			}).
			WithErrors("chat_not_found", "chat_unavailable"),
	}
}

func runSnapshot(r store.RunRow, seq int64) RunSnapshot {
	s := RunSnapshot{ID: r.ID, ChatID: r.ChatID, State: r.State, Profile: r.Profile, Model: r.Model, Seq: seq}
	if r.ErrorCode != "" {
		s.Error = &event.RunError{Code: r.ErrorCode, Message: r.ErrorMessage}
	}
	return s
}

func chatItem(c store.ChatRow) ChatItem {
	item := ChatItem{ID: c.ID, Title: c.Title, Model: c.Model, UpdatedAt: c.UpdatedAt}
	if c.ActiveRun != "" {
		item.ActiveRun = &ActiveRun{ID: c.ActiveRun, State: c.ActiveState}
	}
	return item
}

func isOpen(state string) bool {
	return state == string(run.Queued) || state == string(run.Running) || state == string(run.Interrupted)
}

// transcript turns the views' rows into the wire shape; retracted messages are left out.
func transcript(msgs []store.MessageRow, runs []store.RunRow, seq int64) (Transcript, error) {
	out := Transcript{Seq: seq, Items: []TranscriptItem{}, Runs: make([]RunSnapshot, 0, len(runs))}
	for _, m := range msgs {
		if m.Retracted {
			continue
		}
		var parts []event.MessagePart
		if err := json.Unmarshal(m.Parts, &parts); err != nil {
			return Transcript{}, fmt.Errorf("message %d: %w", m.Seq, err)
		}
		item := TranscriptItem{Seq: m.Seq, RunID: m.RunID}
		switch m.Role {
		case "user":
			item.Kind, item.Text = "input", textOf(parts)
		case "summary":
			item.Kind, item.Text = "summary", textOf(parts)
		case "assistant":
			var stats event.MessageStats
			if err := json.Unmarshal(m.Stats, &stats); err != nil {
				return Transcript{}, fmt.Errorf("message %d stats: %w", m.Seq, err)
			}
			item.Kind, item.Parts, item.Stats, item.Partial, item.Failed = "answer", parts, &stats, m.Partial, m.Failed
		default:
			continue
		}
		out.Items = append(out.Items, item)
	}
	for _, r := range runs {
		snap := runSnapshot(r, seq)
		out.Runs = append(out.Runs, snap)
		if isOpen(r.State) {
			out.ActiveRun = &snap
		}
	}
	return out, nil
}

func textOf(parts []event.MessagePart) string {
	text := ""
	for _, p := range parts {
		if p.Kind == "text" {
			text += p.Text
		}
	}
	return text
}
