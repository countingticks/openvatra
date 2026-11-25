package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/chats"
	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/profile"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/provider/providertest"
	"github.com/countingticks/openvatra/core/internal/run"
	"github.com/countingticks/openvatra/core/internal/sched"
	"github.com/countingticks/openvatra/core/internal/store"
)

type runsFixture struct {
	t      *testing.T
	store  *store.Store
	model  *providertest.Scripted
	engine *run.Engine
	deps   Deps
	h      http.Handler
	events <-chan event.Event
}

var chatModels = []provider.Model{{ID: "m1", Kind: provider.ModelChat, Context: 8192}}

// noTitles is the built-in profiles with chat titles off, so a scripted turn is never spent on a title.
func noTitles() *profile.Registry {
	chat, _ := profile.Builtin().Get("chat")
	chat.Title = false
	return profile.Builtin().With(chat)
}

// newRunsFixture is the full handler over a real store, engine and chats service, the model answering with turns.
// list is the installed model list.
func newRunsFixture(t *testing.T, list []provider.Model, turns ...providertest.Turn) *runsFixture {
	t.Helper()
	model := providertest.NewScripted(turns...)
	f := newRunsFixtureWith(t, list, model)
	f.model = model
	return f
}

// newRunsFixtureWith is newRunsFixture with its own chat model.
func newRunsFixtureWith(t *testing.T, list []provider.Model, model provider.Chat) *runsFixture {
	t.Helper()
	bus := event.NewBus(4096)
	st, err := store.Open(t.TempDir(), bus)
	if err != nil {
		t.Fatal(err)
	}
	_, events, cancel := bus.Subscribe(event.Filter{})
	cfg := config.New(st, slog.New(slog.DiscardHandler))
	config.Register[chats.Settings, struct{}](cfg, chats.ID, chats.DefaultSettings(), nil)
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
	svc := chats.New(chats.Config{Store: st, Engine: eng, Config: cfg,
		Models: func(context.Context) ([]provider.Model, error) { return list, nil }})
	deps := Deps{Chats: svc, Runs: eng, Log: st.Log()}
	return &runsFixture{t: t, store: st, engine: eng, deps: deps, h: testHandler(t, deps), events: events}
}

func (f *runsFixture) call(method, path, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return callHandler(f.h, method, path, body)
}

func callHandler(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// start posts a send and decodes its 202.
func (f *runsFixture) start(body string) RunRef {
	f.t.Helper()
	rec := f.call(http.MethodPost, "/api/runs", body)
	if rec.Code != http.StatusAccepted {
		f.t.Fatalf("POST /api/runs = %d %s", rec.Code, rec.Body)
	}
	var ref RunRef
	if err := json.Unmarshal(rec.Body.Bytes(), &ref); err != nil {
		f.t.Fatal(err)
	}
	return ref
}

func (f *runsFixture) get(path string, out any) {
	f.t.Helper()
	rec := f.call(http.MethodGet, path, "")
	if rec.Code != http.StatusOK {
		f.t.Fatalf("GET %s = %d %s", path, rec.Code, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		f.t.Fatal(err)
	}
}

// waitFor reads published events until one of type typ on runID's stream arrives, for at most 5 s.
func (f *runsFixture) waitFor(typ, runID string) event.Event {
	f.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-f.events:
			if e.Type == typ && e.Stream == "run:"+runID {
				return e
			}
		case <-deadline:
			f.t.Fatalf("no %s for run %s within 5 s", typ, runID)
		}
	}
}

// answering waits until the model has been asked.
func (f *runsFixture) answering() {
	f.t.Helper()
	select {
	case <-f.model.Started():
	case <-time.After(5 * time.Second):
		f.t.Fatal("the model was not asked")
	}
}

func wantErrorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status || errorBody(t, rec)["error"] != code {
		t.Errorf("got %d %s, want %d %s", rec.Code, rec.Body, status, code)
	}
}

var hiTurn = providertest.Turn{Text: []string{"h", "i"}, Usage: provider.Usage{PromptTokens: 5, AnswerTokens: 1, Exact: true}}

func TestStartRunAnswers202WithRunChatAndSeq(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn)
	ref := f.start(`{"requestId":"r1","text":"hello"}`)
	if ref.RunID == "" || ref.ChatID == "" || ref.Seq == 0 {
		t.Fatalf("ref = %+v, want a run, a chat and a seq", ref)
	}
	var body ChatBody
	f.get("/api/chats/"+ref.ChatID, &body)
	if body.Chat.Model != "m1" {
		t.Errorf("chat model = %q, want m1", body.Chat.Model)
	}
}

func TestStartRunTwiceWithOneRequestIDAnswersTheSameRun(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, hiTurn)
	first := f.start(`{"requestId":"r1","text":"hello"}`)
	second := f.start(`{"requestId":"r1","text":"hello"}`)
	if first.RunID != second.RunID || first.ChatID != second.ChatID {
		t.Errorf("second = %+v, want %+v", second, first)
	}
}

func TestStartRunWithAQuoteListsItOnTheInput(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn)
	ref := f.start(`{"requestId":"r1","text":"why?","quotes":["one","two"]}`)
	f.waitFor("run.finished", ref.RunID)
	var tr Transcript
	f.get("/api/chats/"+ref.ChatID+"/messages", &tr)
	for _, it := range tr.Items {
		if it.Kind == "input" {
			if it.Text != "why?" || !slices.Equal(it.Quotes, []string{"one", "two"}) {
				t.Errorf("input = %+v, want text why? and quotes one, two", it)
			}
			return
		}
	}
	t.Fatal("no input in the transcript")
}

func TestStartRunErrors(t *testing.T) {
	f := newRunsFixture(t, chatModels)
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs", `{"requestId":"r1","text":"  "}`), 400, "bad_request")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs", `{"requestId":"r1","chatId":"nope","text":"hi"}`), 404,
		"chat_not_found")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs", `{"requestId":"r1","model":"nope","text":"hi"}`), 404,
		"model_not_found")
	for name, body := range map[string]string{
		"a quote of only spaces": `{"requestId":"r1","text":"hi","quotes":["   "]}`,
		"a quote too long":       `{"requestId":"r1","text":"hi","quotes":["` + strings.Repeat("a", 4001) + `"]}`,
		"a quote without text":   `{"requestId":"r1","quotes":["q"]}`,
		"6 quotes":               `{"requestId":"r1","text":"hi","quotes":["1","2","3","4","5","6"]}`,
	} {
		t.Run(name, func(t *testing.T) { wantErrorCode(t, f.call(http.MethodPost, "/api/runs", body), 400, "bad_request") })
	}

	g := newRunsFixture(t, []provider.Model{{ID: "e1", Kind: provider.ModelEmbedding}})
	wantErrorCode(t, g.call(http.MethodPost, "/api/runs", `{"requestId":"r1","text":"hi"}`), 409, "no_chat_model")
}

func TestListChatsShowsTheActiveRunWhileItAnswers(t *testing.T) {
	f := newRunsFixture(t, chatModels, providertest.Turn{Text: []string{"so far"}, Hang: true})
	ref := f.start(`{"requestId":"r1","text":"hello"}`)
	f.answering()

	var list ChatList
	f.get("/api/chats", &list)
	if len(list.Chats) != 1 || list.Chats[0].ID != ref.ChatID || list.Chats[0].ActiveRun == nil ||
		*list.Chats[0].ActiveRun != (ActiveRun{ID: ref.RunID, State: "running"}) {
		t.Fatalf("while answering: %+v, want chat %s with run %s running", list.Chats, ref.ChatID, ref.RunID)
	}
	if list.Seq == 0 {
		t.Error("seq = 0")
	}

	if rec := f.call(http.MethodPost, "/api/runs/"+ref.RunID+"/stop", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("stop = %d %s", rec.Code, rec.Body)
	}
	var after ChatList // a fresh value: decoding into list would keep its old activeRun
	f.get("/api/chats", &after)
	if len(after.Chats) != 1 || after.Chats[0].ActiveRun != nil {
		t.Errorf("after: %+v, want the chat without an active run", after.Chats)
	}
}

func TestTranscriptIsInputThenAnswerWithStatsAndTheRun(t *testing.T) {
	// The exact prompt size is above the system prompt's estimate, so the parts add up to used.
	f := newRunsFixture(t, chatModels, providertest.Turn{Text: []string{"h", "i"}, Usage: provider.Usage{PromptTokens: 200, AnswerTokens: 1, Exact: true}})
	ref := f.start(`{"requestId":"r1","text":"hello"}`)
	f.waitFor("run.finished", ref.RunID)

	var tr Transcript
	f.get("/api/chats/"+ref.ChatID+"/messages", &tr)
	if len(tr.Items) != 2 {
		t.Fatalf("items = %+v, want input and answer", tr.Items)
	}
	in, ans := tr.Items[0], tr.Items[1]
	if in.Kind != "input" || in.Text != "hello" || in.RunID != ref.RunID {
		t.Errorf("first item = %+v, want the input", in)
	}
	if ans.Kind != "answer" || len(ans.Parts) != 1 || ans.Parts[0] != (event.MessagePart{Kind: "text", Text: "hi"}) ||
		ans.Stats == nil || ans.Stats.AnswerTokens != 1 || !ans.Stats.Exact || ans.Partial || ans.Failed {
		t.Errorf("second item = %+v (stats %+v), want the answer hi with exact stats", ans, ans.Stats)
	}
	if in.Time <= 0 || ans.Time <= 0 || in.Time > ans.Time {
		t.Errorf("times %d, %d: want both set and the input not after the answer", in.Time, ans.Time)
	}
	if in.Seq >= ans.Seq {
		t.Errorf("seqs %d, %d: want oldest first", in.Seq, ans.Seq)
	}
	if len(tr.Runs) != 1 || tr.Runs[0].ID != ref.RunID || tr.Runs[0].State != "done" || tr.ActiveRun != nil {
		t.Errorf("runs = %+v, active %+v; want one done run and none active", tr.Runs, tr.ActiveRun)
	}
	if tr.Context.Size != 8192 || tr.Context.Used <= 0 {
		t.Errorf("context = %+v, want size 8192 and some used", tr.Context)
	}
	if p := tr.Context.Parts; p.MessageCount <= 0 || p.System+p.Messages != tr.Context.Used {
		t.Errorf("parts = %+v, want messages counted and system + messages == used", p)
	}
}

func TestStopEndsStoppedAndResumeOfADoneRunIsNotInterrupted(t *testing.T) {
	f := newRunsFixture(t, chatModels, providertest.Turn{Text: []string{"so far"}, Hang: true}, hiTurn)
	hanging := f.start(`{"requestId":"r1","text":"hello"}`)
	f.answering()
	if rec := f.call(http.MethodPost, "/api/runs/"+hanging.RunID+"/stop", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("stop = %d %s", rec.Code, rec.Body)
	}
	var snap RunSnapshot
	f.get("/api/runs/"+hanging.RunID, &snap)
	if snap.State != "stopped" || snap.ChatID != hanging.ChatID || snap.Model != "m1" || snap.Profile != "chat" {
		t.Errorf("run = %+v, want stopped", snap)
	}

	done := f.start(`{"requestId":"r2","text":"again"}`)
	f.waitFor("run.finished", done.RunID)
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs/"+done.RunID+"/resume", ""), 409, "run_not_interrupted")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs/nope/stop", ""), 404, "run_not_found")
	wantErrorCode(t, f.call(http.MethodGet, "/api/runs/nope", ""), 404, "run_not_found")
}

func TestPatchRenamesAndDeleteRemoves(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn)
	ref := f.start(`{"requestId":"r1","text":"hello"}`)
	f.waitFor("run.finished", ref.RunID)

	rec := f.call(http.MethodPatch, "/api/chats/"+ref.ChatID, `{"title":"Trip"}`)
	var body ChatBody
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil || body.Chat.Title != "Trip" {
		t.Fatalf("PATCH = %d %s, want the chat titled Trip", rec.Code, rec.Body)
	}
	wantErrorCode(t, f.call(http.MethodPatch, "/api/chats/"+ref.ChatID, `{"title":""}`), 400, "bad_request")

	if rec := f.call(http.MethodDelete, "/api/chats/"+ref.ChatID, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d %s", rec.Code, rec.Body)
	}
	wantErrorCode(t, f.call(http.MethodGet, "/api/chats/"+ref.ChatID, ""), 404, "chat_not_found")
}

func TestRunAndChatRoutesWithoutADatabaseAre503(t *testing.T) {
	h := testHandler(t, Deps{})
	for _, c := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/runs", `{"requestId":"r1","text":"hi"}`},
		{http.MethodGet, "/api/runs/x", ""},
		{http.MethodPost, "/api/runs/x/stop", ""},
		{http.MethodPost, "/api/runs/x/resume", ""},
		{http.MethodGet, "/api/chats", ""},
		{http.MethodGet, "/api/chats/x", ""},
		{http.MethodGet, "/api/chats/x/messages", ""},
		{http.MethodPatch, "/api/chats/x", `{"title":"t"}`},
		{http.MethodDelete, "/api/chats/x", ""},
		{http.MethodGet, "/api/chats/x/export", ""},
	} {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			wantErrorCode(t, callHandler(h, c.method, c.path, c.body), 503, "chat_unavailable")
		})
	}
}

// inputs is the text of each input in the chat's transcript, in order.
func (f *runsFixture) inputs(chatID string) []string {
	f.t.Helper()
	var tr Transcript
	f.get("/api/chats/"+chatID+"/messages", &tr)
	var out []string
	for _, it := range tr.Items {
		if it.Kind == "input" {
			out = append(out, it.Text)
		}
	}
	return out
}

func TestStartRunWithReplaceLastSendsTheLastTurnAgain(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, hiTurn, hiTurn)
	first := f.start(`{"requestId":"r1","text":"hello"}`)
	f.waitFor("run.finished", first.RunID)

	regen := f.start(`{"requestId":"r2","chatId":"` + first.ChatID + `","replace":"last"}`)
	if regen.RunID == first.RunID || regen.ChatID != first.ChatID {
		t.Fatalf("regenerate = %+v, want a new run of chat %s", regen, first.ChatID)
	}
	f.waitFor("run.finished", regen.RunID)
	if got := f.inputs(first.ChatID); len(got) != 1 || got[0] != "hello" {
		t.Errorf("inputs after regenerate = %v, want [hello]", got)
	}

	edit := f.start(`{"requestId":"r3","chatId":"` + first.ChatID + `","replace":"last","text":"hello again"}`)
	f.waitFor("run.finished", edit.RunID)
	if got := f.inputs(first.ChatID); len(got) != 1 || got[0] != "hello again" {
		t.Errorf("inputs after edit = %v, want [hello again]", got)
	}
}

func TestStartRunWithReplaceErrors(t *testing.T) {
	f := newRunsFixture(t, chatModels, providertest.Turn{Text: []string{"so far"}, Hang: true})
	ref := f.start(`{"requestId":"r1","text":"hello"}`)
	f.answering()
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs", `{"requestId":"r2","chatId":"`+ref.ChatID+`","replace":"first"}`),
		400, "invalid_request")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs", `{"requestId":"r3","chatId":"`+ref.ChatID+`","replace":"last"}`),
		409, "chat_busy")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs", `{"requestId":"r4","replace":"last"}`), 400, "bad_request")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs",
		`{"requestId":"r5","chatId":"`+ref.ChatID+`","replace":"last","replaceFrom":"x","text":"t"}`), 400, "bad_request")
	wantErrorCode(t, f.call(http.MethodPost, "/api/runs",
		`{"requestId":"r6","chatId":"`+ref.ChatID+`","replaceFrom":"x"}`), 400, "bad_request")

	idle := newRunsFixture(t, chatModels, hiTurn)
	done := idle.start(`{"requestId":"r1","text":"hello"}`)
	idle.waitFor("run.finished", done.RunID)
	wantErrorCode(t, idle.call(http.MethodPost, "/api/runs",
		`{"requestId":"r2","chatId":"`+done.ChatID+`","replaceFrom":"missing","text":"t"}`), 404, "run_not_found")
}

func TestStartRunWithReplaceFromSendsTheEditedText(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, hiTurn, hiTurn)
	first := f.start(`{"requestId":"r1","text":"hello"}`)
	f.waitFor("run.finished", first.RunID)
	second := f.start(`{"requestId":"r2","chatId":"` + first.ChatID + `","text":"again"}`)
	f.waitFor("run.finished", second.RunID)

	edit := f.start(`{"requestId":"r3","chatId":"` + first.ChatID + `","replaceFrom":"` + first.RunID + `","text":"edited"}`)
	if edit.RunID == first.RunID || edit.RunID == second.RunID {
		t.Fatalf("edit = %+v, want a new run", edit)
	}
	f.waitFor("run.finished", edit.RunID)
	if got := f.inputs(first.ChatID); len(got) != 1 || got[0] != "edited" {
		t.Errorf("inputs after edit = %v, want [edited]", got)
	}
}

func TestRewindChatAnswersTheFirstInputAndRetractsTheRest(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, hiTurn, hiTurn)
	first := f.start(`{"requestId":"r1","text":"one"}`)
	f.waitFor("run.finished", first.RunID)
	second := f.start(`{"requestId":"r2","chatId":"` + first.ChatID + `","text":"two","quotes":["one","two"]}`)
	f.waitFor("run.finished", second.RunID)
	third := f.start(`{"requestId":"r3","chatId":"` + first.ChatID + `","text":"three"}`)
	f.waitFor("run.finished", third.RunID)

	rec := f.call(http.MethodPost, "/api/chats/"+first.ChatID+"/rewind", `{"runId":"`+second.RunID+`"}`)
	var got Rewound
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatalf("rewind = %d %s", rec.Code, rec.Body)
	}
	if got.Text != "two" || !slices.Equal(got.Quotes, []string{"one", "two"}) || got.Seq <= 0 {
		t.Errorf("rewound = %+v, want text two, its quote and a seq", got)
	}
	if in := f.inputs(first.ChatID); len(in) != 1 || in[0] != "one" {
		t.Errorf("inputs after rewind = %v, want [one]", in)
	}
}

func TestRewindChatErrors(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, providertest.Turn{Text: []string{"so far"}, Hang: true})
	first := f.start(`{"requestId":"r1","text":"one"}`)
	f.waitFor("run.finished", first.RunID)
	path := "/api/chats/" + first.ChatID + "/rewind"

	wantErrorCode(t, f.call(http.MethodPost, "/api/chats/missing/rewind", `{"runId":"`+first.RunID+`"}`), 404, "chat_not_found")
	wantErrorCode(t, f.call(http.MethodPost, path, `{"runId":""}`), 400, "bad_request")
	if rec := f.call(http.MethodPost, path, `{"runId":"`+first.RunID+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("rewind = %d %s", rec.Code, rec.Body)
	}
	wantErrorCode(t, f.call(http.MethodPost, path, `{"runId":"`+first.RunID+`"}`), 404, "run_not_found")

	f.start(`{"requestId":"r2","chatId":"` + first.ChatID + `","text":"two"}`)
	f.answering()
	wantErrorCode(t, f.call(http.MethodPost, path, `{"runId":"`+first.RunID+`"}`), 409, "chat_busy")
}

func TestListChatsWithQFindsMatchingChatsWithASnippet(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, hiTurn)
	match := f.start(`{"requestId":"r1","text":"the quick brown fox"}`)
	f.waitFor("run.finished", match.RunID)
	other := f.start(`{"requestId":"r2","text":"something else"}`)
	f.waitFor("run.finished", other.RunID)

	var list ChatList
	f.get("/api/chats?q=brow", &list)
	if len(list.Chats) != 1 || list.Chats[0].ID != match.ChatID || list.Seq == 0 {
		t.Fatalf("q=brow: %+v, want only chat %s", list, match.ChatID)
	}
	var matched []string
	for _, p := range list.Chats[0].Snippet {
		if p.Match {
			matched = append(matched, p.Text)
		}
	}
	if len(matched) != 1 || matched[0] != "brown" {
		t.Errorf("snippet = %+v, want brown marked", list.Chats[0].Snippet)
	}

	rec := f.call(http.MethodGet, "/api/chats?q=", "")
	var all ChatList
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &all) != nil || len(all.Chats) != 2 {
		t.Fatalf("q= : %d %s, want both chats", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), `"snippet"`) {
		t.Errorf("a plain list carries snippets: %s", rec.Body)
	}
}

func TestChatItemsCarryTheirTitleSource(t *testing.T) {
	f := newRunsFixture(t, chatModels, hiTurn, hiTurn)
	renamed := f.start(`{"requestId":"r1","text":"hello"}`)
	f.waitFor("run.finished", renamed.RunID)
	fresh := f.start(`{"requestId":"r2","text":"again"}`)
	f.waitFor("run.finished", fresh.RunID)
	if rec := f.call(http.MethodPatch, "/api/chats/"+renamed.ChatID, `{"title":"Trip"}`); rec.Code != http.StatusOK {
		t.Fatalf("PATCH = %d %s", rec.Code, rec.Body)
	}

	var list ChatList
	f.get("/api/chats", &list)
	sources := map[string]string{}
	for _, c := range list.Chats {
		sources[c.ID] = c.TitleSource
	}
	if sources[renamed.ChatID] != "user" || sources[fresh.ChatID] != "auto" {
		t.Errorf("title sources = %v, want user for the renamed chat and auto for the other", sources)
	}
}

func TestExportChatIsMarkdownInReadingOrder(t *testing.T) {
	models := []provider.Model{{ID: "tiny", Kind: provider.ModelChat, Context: 8192}}
	f := newRunsFixture(t, models,
		providertest.Turn{Reasoning: []string{"secret thoughts"}, Text: []string{"first answer"}},
		providertest.Turn{Text: []string{"old answer"}},
		providertest.Turn{Text: []string{"new answer"}},
		providertest.Turn{Text: []string{"half"}, Hang: true})
	first := f.start(`{"requestId":"r1","text":"hello"}`)
	f.waitFor("run.finished", first.RunID)
	chat := first.ChatID
	second := f.start(`{"requestId":"r2","chatId":"` + chat + `","text":"second","quotes":["one","two"]}`)
	f.waitFor("run.finished", second.RunID)
	regen := f.start(`{"requestId":"r3","chatId":"` + chat + `","replace":"last"}`)
	f.waitFor("run.finished", regen.RunID)
	stopped := f.start(`{"requestId":"r4","chatId":"` + chat + `","text":"third"}`)
	f.waitFor("message.delta", stopped.RunID)
	if rec := f.call(http.MethodPost, "/api/runs/"+stopped.RunID+"/stop", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("stop = %d %s", rec.Code, rec.Body)
	}

	rec := f.call(http.MethodGet, "/api/chats/"+chat+"/export", "")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "text/markdown; charset=utf-8" {
		t.Fatalf("export = %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	want := "# hello\n\n## You\n\nhello\n\n## tiny\n\nfirst answer\n\n## You\n\n> one\n\n> two\n\nsecond\n\n## tiny\n\nnew answer\n\n" +
		"## You\n\nthird\n\n## tiny\n\nhalf\n\n_(stopped)_\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("export =\n%s\nwant\n%s", got, want)
	}

	wantErrorCode(t, f.call(http.MethodGet, "/api/chats/nope/export", ""), 404, "chat_not_found")
}

// twoPhase answers "ab", waits for resume, then plays its scripted turns ("c" and a hang): a stream can attach
// between the two phases.
type twoPhase struct {
	*providertest.Scripted
	firstPart chan struct{} // closed once "ab" is out
	resume    chan struct{}
}

func (p *twoPhase) Complete(ctx context.Context, req provider.Request, emit func(provider.Delta)) (provider.Result, error) {
	emit(provider.Delta{Kind: provider.PartText, Text: "a"})
	emit(provider.Delta{Kind: provider.PartText, Text: "b"})
	close(p.firstPart)
	select {
	case <-p.resume:
	case <-ctx.Done():
	}
	res, err := p.Scripted.Complete(ctx, req, emit)
	res.Parts = append([]provider.Part{{Kind: provider.PartText, Text: "ab"}}, res.Parts...)
	return res, err
}

func TestAStreamOpenedMidAnswerGetsThePartialThenHigherDeltas(t *testing.T) {
	model := &twoPhase{Scripted: providertest.NewScripted(providertest.Turn{Text: []string{"c"}, Hang: true}),
		firstPart: make(chan struct{}), resume: make(chan struct{})}
	f := newRunsFixtureWith(t, chatModels, model)
	ref := f.start(`{"requestId":"r1","text":"hello"}`)
	select {
	case <-model.firstPart:
	case <-time.After(5 * time.Second):
		t.Fatal("the model did not start answering")
	}

	// The full handler, with the gate's host and token filled in for the plain client openStream uses.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Host = "127.0.0.1:53121"
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.URL.Path = "/api/events"
		f.h.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	events := openStream(t, srv, "stream=run:"+ref.RunID, false)
	if hello := nextEvent(t, events); !strings.HasPrefix(hello, "event: hello|") {
		t.Fatalf("first frame = %q, want hello", hello)
	}
	_, e := logEvent(t, nextEvent(t, events))
	var partial event.MessagePartial
	if err := json.Unmarshal(e.Data, &partial); err != nil || e.Type != "message.partial" || partial.Text != "ab" ||
		partial.N != 2 {
		t.Fatalf("frame = %+v, want message.partial ab at n 2", e)
	}

	close(model.resume)
	_, e = logEvent(t, nextEvent(t, events))
	var delta event.MessageDelta
	if err := json.Unmarshal(e.Data, &delta); err != nil || e.Type != "message.delta" || delta.Text != "c" ||
		delta.N != 3 {
		t.Fatalf("frame = %+v, want message.delta c at n 3", e)
	}
}
