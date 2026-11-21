package chats

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/profile"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/provider/providertest"
	"github.com/countingticks/openvatra/core/internal/run"
	"github.com/countingticks/openvatra/core/internal/sched"
	"github.com/countingticks/openvatra/core/internal/store"
)

var bg = context.Background()

// installed is the model list the fixtures see: an embedding model first, then two chat models.
var installed = []provider.Model{
	{ID: "e1", Kind: provider.ModelEmbedding},
	{ID: "m1", Kind: provider.ModelChat, Context: 8192},
	{ID: "m2", Kind: provider.ModelChat, Context: 8192},
}

type fixture struct {
	t      *testing.T
	store  *store.Store
	cfg    *config.Store
	model  *providertest.Scripted
	svc    *Service
	events <-chan event.Event
}

// newFixture is a service over a real store, its config and an engine answering with turns, with list installed.
func newFixture(t *testing.T, list []provider.Model, turns ...providertest.Turn) *fixture {
	t.Helper()
	bus := event.NewBus(4096)
	st, err := store.Open(t.TempDir(), bus)
	if err != nil {
		t.Fatal(err)
	}
	_, events, cancel := bus.Subscribe(event.Filter{})
	discard := slog.New(slog.DiscardHandler)
	cfg := config.New(st, discard)
	config.Register[Settings, struct{}](cfg, ID, DefaultSettings(), nil)
	model := providertest.NewScripted(turns...)
	models := func(context.Context) ([]provider.Model, error) { return list, nil }
	eng := run.New(run.Config{
		Log: st.Log(), Views: st, Chat: model, Sched: sched.NewFIFO(nil), Profiles: noTitles(),
		Model: func(_ context.Context, id string) (provider.Model, error) {
			return provider.Model{ID: id, Kind: provider.ModelChat, Context: 8192}, nil
		},
	})
	t.Cleanup(func() {
		eng.Close()
		cancel()
		st.Close()
	})
	svc := New(Config{Store: st, Engine: eng, Config: cfg, Models: models})
	return &fixture{t: t, store: st, cfg: cfg, model: model, svc: svc, events: events}
}

var answer = providertest.Turn{Text: []string{"hi"}}

// noTitles is the built-in profiles with chat titles off, so a scripted turn is never spent on a title.
func noTitles() *profile.Registry {
	chat, _ := profile.Builtin().Get("chat")
	chat.Title = false
	return profile.Builtin().With(chat)
}

func (f *fixture) send(in SendInput) run.Ref {
	f.t.Helper()
	ref, err := f.svc.Send(bg, in)
	if err != nil {
		f.t.Fatalf("Send(%+v): %v", in, err)
	}
	return ref
}

// waitFor reads published events until one of type typ on stream arrives, for at most 5 s, and returns every
// event read on the way, that one last.
func (f *fixture) waitFor(typ, stream string) []event.Event {
	f.t.Helper()
	var seen []event.Event
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-f.events:
			seen = append(seen, e)
			if e.Type == typ && e.Stream == stream {
				return seen
			}
		case <-deadline:
			f.t.Fatalf("no %s on %s within 5 s", typ, stream)
		}
	}
}

func (f *fixture) chatModel(id string) string {
	f.t.Helper()
	chat, _, err := f.svc.Get(bg, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return chat.Model
}

func (f *fixture) setLastModel(model string) {
	f.t.Helper()
	entry, err := f.cfg.Section(ID)
	if err != nil {
		f.t.Fatal(err)
	}
	value, _ := json.Marshal(Settings{LastModel: &model})
	if _, err := f.cfg.Put(ID, entry.Rev, value); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) lastModel() *string {
	return config.Get[Settings](f.cfg, ID).LastModel
}

func TestNewChatWithoutModelUsesLastModelThenFirstInstalled(t *testing.T) {
	f := newFixture(t, installed, answer, answer)
	f.setLastModel("m2")
	ref := f.send(SendInput{RequestID: "r1", Text: "hello"})
	if got := f.chatModel(ref.ChatID); got != "m2" {
		t.Errorf("with lastModel m2: chat model = %q, want m2", got)
	}

	g := newFixture(t, installed, answer)
	ref = g.send(SendInput{RequestID: "r1", Text: "hello"})
	if got := g.chatModel(ref.ChatID); got != "m1" {
		t.Errorf("without lastModel: chat model = %q, want m1 (the first chat model)", got)
	}
	if g.lastModel() != nil {
		t.Errorf("lastModel = %q, want nil: no model was named", *g.lastModel())
	}
}

func TestSendWithNoChatModelWritesNothing(t *testing.T) {
	f := newFixture(t, []provider.Model{{ID: "e1", Kind: provider.ModelEmbedding}}, answer)
	_, err := f.svc.Send(bg, SendInput{RequestID: "r1", Text: "hello"})
	if !errors.Is(err, ErrNoChatModel) {
		t.Fatalf("Send = %v, want ErrNoChatModel", err)
	}
	events, err := f.store.Log().Read(bg, 0, event.Filter{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Errorf("stored %d events, want none", len(events))
	}
}

func TestExplicitModelIsRememberedAsLastModel(t *testing.T) {
	f := newFixture(t, installed, answer, answer)
	f.send(SendInput{RequestID: "r1", Model: "m2", Text: "hello"})
	if last := f.lastModel(); last == nil || *last != "m2" {
		t.Fatalf("lastModel = %v, want m2", last)
	}
	ref := f.send(SendInput{RequestID: "r2", Text: "again"})
	if got := f.chatModel(ref.ChatID); got != "m2" {
		t.Errorf("next chat's model = %q, want m2", got)
	}
}

func TestStaleLastModelFallsBackToFirstInstalled(t *testing.T) {
	f := newFixture(t, installed, answer)
	f.setLastModel("gone")
	ref := f.send(SendInput{RequestID: "r1", Text: "hello"})
	if got := f.chatModel(ref.ChatID); got != "m1" {
		t.Errorf("chat model = %q, want m1", got)
	}
}

func TestUnknownExplicitModelIsErrUnknownModel(t *testing.T) {
	for _, model := range []string{"nope", "e1"} {
		t.Run(model, func(t *testing.T) {
			f := newFixture(t, installed, answer)
			_, err := f.svc.Send(bg, SendInput{RequestID: "r1", Model: model, Text: "hello"})
			if !errors.Is(err, provider.ErrUnknownModel) {
				t.Fatalf("Send = %v, want ErrUnknownModel", err)
			}
			if f.lastModel() != nil {
				t.Errorf("lastModel = %q, want nil", *f.lastModel())
			}
		})
	}
}

func TestChangingTheModelOnSendAppendsChatModelBeforeTheRun(t *testing.T) {
	f := newFixture(t, installed, answer, answer)
	first := f.send(SendInput{RequestID: "r1", Model: "m1", Text: "hello"})
	f.waitFor("run.finished", "run:"+first.RunID)

	second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Model: "m2", Text: "again"})
	if second.RunID == first.RunID {
		t.Fatal("the second send went to the finished run")
	}
	events, err := f.store.Log().Read(bg, 0, event.Filter{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	var modelSeq, queuedSeq int64
	for _, e := range events {
		switch {
		case e.Type == "chat.model" && e.Stream == "chat:"+first.ChatID && string(e.Data) == `{"model":"m2"}`:
			modelSeq = e.Seq
		case e.Type == "run.queued" && e.Stream == "run:"+second.RunID:
			queuedSeq = e.Seq
		}
	}
	if modelSeq == 0 || queuedSeq == 0 || modelSeq > queuedSeq {
		t.Fatalf("chat.model m2 at seq %d, run.queued at %d: want the model first", modelSeq, queuedSeq)
	}
	row, _, err := f.store.Run(bg, second.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Model != "m2" {
		t.Errorf("run model = %q, want m2", row.Model)
	}
}

func TestUpdateRenamesAsUserAndChangesModel(t *testing.T) {
	f := newFixture(t, installed, answer)
	ref := f.send(SendInput{RequestID: "r1", Model: "m1", Text: "hello"})

	title, model := "  Trip plans  ", "m2"
	chat, _, err := f.svc.Update(bg, ref.ChatID, &title, &model)
	if err != nil {
		t.Fatal(err)
	}
	if chat.Title != "Trip plans" || chat.TitleSource != "user" || chat.Model != "m2" {
		t.Errorf("chat = %q (%s) on %q, want Trip plans (user) on m2", chat.Title, chat.TitleSource, chat.Model)
	}

	for _, bad := range []string{"", "   "} {
		if _, _, err := f.svc.Update(bg, ref.ChatID, &bad, nil); !errors.Is(err, run.ErrBadInput) {
			t.Errorf("Update(title %q) = %v, want ErrBadInput", bad, err)
		}
	}
	unknown := "nope"
	if _, _, err := f.svc.Update(bg, ref.ChatID, nil, &unknown); !errors.Is(err, provider.ErrUnknownModel) {
		t.Errorf("Update(model nope) = %v, want ErrUnknownModel", err)
	}
	if _, _, err := f.svc.Update(bg, "missing", &title, nil); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Update(missing chat) = %v, want ErrNotFound", err)
	}
}

func TestDeleteStopsTheActiveRunThenRemovesTheChat(t *testing.T) {
	f := newFixture(t, installed, providertest.Turn{Text: []string{"so far"}, Hang: true})
	ref := f.send(SendInput{RequestID: "r1", Text: "hello"})
	select {
	case <-f.model.Started():
	case <-time.After(5 * time.Second):
		t.Fatal("the model was not asked")
	}

	if err := f.svc.Delete(bg, ref.ChatID); err != nil {
		t.Fatal(err)
	}
	seen := f.waitFor("chat.deleted", "system")
	stopped := false
	for _, e := range seen {
		if e.Type == "run.finished" && e.Stream == "run:"+ref.RunID {
			var fin event.RunFinished
			if err := json.Unmarshal(e.Data, &fin); err != nil {
				t.Fatal(err)
			}
			stopped = fin.State == "stopped"
		}
	}
	if !stopped {
		t.Error("the run did not finish stopped before chat.deleted")
	}
	if _, _, err := f.svc.Get(bg, ref.ChatID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Get after Delete = %v, want ErrNotFound", err)
	}
}

func TestContextOfAnUnknownChatIsErrNotFound(t *testing.T) {
	f := newFixture(t, installed)
	if _, _, err := f.svc.Context(bg, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want store.ErrNotFound", err)
	}
}
