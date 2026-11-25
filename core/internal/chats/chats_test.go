package chats

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"sync"
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
	eng    *run.Engine
	svc    *Service
	events <-chan event.Event

	mu        sync.Mutex
	list      []provider.Model
	modelsErr error
}

// setModels replaces the installed models the service sees from now on.
func (f *fixture) setModels(list []provider.Model) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.list = list
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
	f := &fixture{t: t, store: st, cfg: cfg, events: events, list: list}
	models := func(context.Context) ([]provider.Model, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.list, f.modelsErr
	}
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
	f.model, f.eng = model, eng
	f.svc = New(Config{Store: st, Engine: eng, Config: cfg, Models: models})
	return f
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

func TestReplaceNeedsAChatAndAppendsANewModelBeforeTheRun(t *testing.T) {
	f := newFixture(t, installed, answer, answer)
	for _, in := range []SendInput{
		{RequestID: "r0", Replace: true},
		{RequestID: "r0", Replace: true, Text: "hello"},
	} {
		if _, err := f.svc.Send(bg, in); !errors.Is(err, run.ErrBadInput) {
			t.Errorf("Send(%+v) = %v, want ErrBadInput", in, err)
		}
	}
	first := f.send(SendInput{RequestID: "r1", Model: "m1", Text: "hello"})
	f.waitFor("run.finished", "run:"+first.RunID)

	second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Model: "m2", Replace: true})
	if second.RunID == first.RunID {
		t.Fatal("replace went to the old run")
	}
	f.waitFor("run.finished", "run:"+second.RunID)
	events, err := f.store.Log().Read(bg, 0, event.Filter{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, e := range events {
		switch {
		case e.Type == "chat.model" && string(e.Data) == `{"model":"m2"}`, e.Type == "turn.retracted",
			e.Type == "run.queued" && e.Stream == "run:"+second.RunID:
			order = append(order, e.Type)
		case e.Type == "input.received" && e.Stream == "run:"+second.RunID:
			var p event.InputReceived
			if err := json.Unmarshal(e.Data, &p); err != nil {
				t.Fatal(err)
			}
			order = append(order, "input "+p.Text)
		}
	}
	if want := []string{"chat.model", "turn.retracted", "run.queued", "input hello"}; !slices.Equal(order, want) {
		t.Fatalf("events %v, want %v", order, want)
	}
	if row, _, err := f.store.Run(bg, second.RunID); err != nil || row.Model != "m2" {
		t.Errorf("run = %+v, %v; want model m2", row, err)
	}
}

func TestReplaceFromIsCheckedBeforeAnythingIsWritten(t *testing.T) {
	f := newFixture(t, installed, answer)
	first := f.firstOnM1()
	before, err := f.store.Log().Read(bg, 0, event.Filter{}, 200)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []SendInput{
		{RequestID: "x", ReplaceFrom: "x", Text: "t"},
		{RequestID: "x", ChatID: first.ChatID, ReplaceFrom: first.RunID, Text: " "},
		{RequestID: "x", ChatID: first.ChatID, ReplaceFrom: first.RunID, Replace: true, Text: "t", Model: "m2"},
	} {
		if _, err := f.svc.Send(bg, in); !errors.Is(err, run.ErrBadInput) {
			t.Errorf("Send(%+v) = %v, want ErrBadInput", in, err)
		}
	}
	after, err := f.store.Log().Read(bg, 0, event.Filter{}, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("%d events appended", len(after)-len(before))
	}
}

// chatModelEvents is the payloads of the chat.model events after the one that created the chat, in log order.
func (f *fixture) chatModelEvents(chatID string) []string {
	f.t.Helper()
	events, err := f.store.Log().Read(bg, 0, event.Filter{}, 200)
	if err != nil {
		f.t.Fatal(err)
	}
	var out []string
	for _, e := range events {
		if e.Type == "chat.model" && e.Stream == "chat:"+chatID {
			out = append(out, string(e.Data))
		}
	}
	return out[1:]
}

func (f *fixture) runModel(runID string) string {
	f.t.Helper()
	row, _, err := f.store.Run(bg, runID)
	if err != nil {
		f.t.Fatal(err)
	}
	return row.Model
}

// firstOnM1 sends a first turn on m1 and waits for it to finish.
func (f *fixture) firstOnM1() run.Ref {
	f.t.Helper()
	first := f.send(SendInput{RequestID: "r1", Model: "m1", Text: "hello"})
	f.waitFor("run.finished", "run:"+first.RunID)
	return first
}

func TestRemovedModelFallsBackOnTheNextSend(t *testing.T) {
	m3 := provider.Model{ID: "m3", Kind: provider.ModelChat, Context: 8192}
	e1 := installed[0]
	m2 := installed[2]

	t.Run("a removed model switches to lastModel when installed", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.setModels([]provider.Model{e1, m3, m2})
		f.setLastModel("m2")

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Text: "again"})

		if got, want := f.chatModelEvents(first.ChatID), []string{`{"model":"m2"}`}; !slices.Equal(got, want) {
			t.Fatalf("chat.model events %v, want %v", got, want)
		}
		if got := f.runModel(second.RunID); got != "m2" {
			t.Errorf("run model = %q, want m2", got)
		}
		events, _ := f.store.Log().Read(bg, 0, event.Filter{}, 200)
		var modelSeq, queuedSeq int64
		for _, e := range events {
			switch {
			case e.Type == "chat.model" && e.Stream == "chat:"+first.ChatID:
				modelSeq = e.Seq
			case e.Type == "run.queued" && e.Stream == "run:"+second.RunID:
				queuedSeq = e.Seq
			}
		}
		if modelSeq == 0 || modelSeq > queuedSeq {
			t.Errorf("chat.model at %d, run.queued at %d: want the model first", modelSeq, queuedSeq)
		}
	})

	t.Run("a removed model switches to the first chat model when lastModel is gone too", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.setModels([]provider.Model{e1, m3, m2})
		f.setLastModel("gone")

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Text: "again"})

		if got, want := f.chatModelEvents(first.ChatID), []string{`{"model":"m3"}`}; !slices.Equal(got, want) {
			t.Fatalf("chat.model events %v, want %v", got, want)
		}
		if got := f.runModel(second.RunID); got != "m3" {
			t.Errorf("run model = %q, want m3", got)
		}
		if last := f.lastModel(); last == nil || *last != "gone" {
			t.Errorf("lastModel = %v, want it untouched", last)
		}
	})

	t.Run("replace on a chat whose model is gone switches too", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.setModels([]provider.Model{e1, m3, m2})
		f.setLastModel("m2")

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Replace: true})

		if got, want := f.chatModelEvents(first.ChatID), []string{`{"model":"m2"}`}; !slices.Equal(got, want) {
			t.Fatalf("chat.model events %v, want %v", got, want)
		}
		if got := f.runModel(second.RunID); got != "m2" {
			t.Errorf("run model = %q, want m2", got)
		}
	})

	t.Run("replace from on a chat whose model is gone switches too", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.setModels([]provider.Model{e1, m3, m2})
		f.setLastModel("m2")

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, ReplaceFrom: first.RunID, Text: "again"})

		if got, want := f.chatModelEvents(first.ChatID), []string{`{"model":"m2"}`}; !slices.Equal(got, want) {
			t.Fatalf("chat.model events %v, want %v", got, want)
		}
		if got := f.runModel(second.RunID); got != "m2" {
			t.Errorf("run model = %q, want m2", got)
		}
	})

	t.Run("with no chat model installed nothing is appended", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.setModels([]provider.Model{e1})

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Text: "again"})

		if got := f.chatModelEvents(first.ChatID); len(got) != 0 {
			t.Errorf("chat.model events %v, want none", got)
		}
		if got := f.runModel(second.RunID); got != "m1" {
			t.Errorf("run model = %q, want m1", got)
		}
	})

	t.Run("a chat whose model is installed is not touched", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.setLastModel("m2")

		f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Text: "again"})

		if got := f.chatModelEvents(first.ChatID); len(got) != 0 {
			t.Errorf("chat.model events %v, want none", got)
		}
	})

	t.Run("an input to an active run appends no chat.model", func(t *testing.T) {
		f := newFixture(t, installed, providertest.Turn{Hang: true})
		first := f.send(SendInput{RequestID: "r1", Model: "m1", Text: "hello"})
		f.waitFor("run.started", "run:"+first.RunID)
		f.setModels([]provider.Model{e1, m2})

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Text: "more"})

		if second.RunID != first.RunID {
			t.Errorf("run = %q, want the active run %q", second.RunID, first.RunID)
		}
		if got := f.chatModelEvents(first.ChatID); len(got) != 0 {
			t.Errorf("chat.model events %v, want none", got)
		}
	})

	t.Run("a failing model list sends with the chat's model", func(t *testing.T) {
		f := newFixture(t, installed, answer, answer)
		first := f.firstOnM1()
		f.mu.Lock()
		f.modelsErr = errors.New("providers down")
		f.mu.Unlock()

		second := f.send(SendInput{RequestID: "r2", ChatID: first.ChatID, Text: "again"})

		if got := f.chatModelEvents(first.ChatID); len(got) != 0 {
			t.Errorf("chat.model events %v, want none", got)
		}
		if got := f.runModel(second.RunID); got != "m1" {
			t.Errorf("run model = %q, want m1", got)
		}
	})
}

func TestExportPutsAQueuedInputAfterTheAnswerItWasSentDuring(t *testing.T) {
	f := newFixture(t, installed, providertest.Turn{Text: []string{"so far"}, Hang: true})
	ref := f.send(SendInput{RequestID: "r1", Model: "m1", Text: "one"})
	f.waitFor("message.delta", "run:"+ref.RunID)
	f.send(SendInput{RequestID: "r2", ChatID: ref.ChatID, Text: "two"})
	if err := f.eng.Stop(bg, ref.RunID); err != nil {
		t.Fatal(err)
	}

	got, err := f.svc.Export(bg, ref.ChatID)
	if err != nil {
		t.Fatal(err)
	}
	if want := "# one\n\n## You\n\none\n\n## m1\n\nso far\n\n_(stopped)_\n\n## You\n\ntwo\n"; got != want {
		t.Errorf("export =\n%s\nwant\n%s", got, want)
	}
	if _, err := f.svc.Export(bg, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Export(nope) = %v, want ErrNotFound", err)
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
	if _, err := f.svc.Context(bg, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want store.ErrNotFound", err)
	}
}
