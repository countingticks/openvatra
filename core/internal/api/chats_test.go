package api

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/store"
)

// chatServer serves the real handler (token and Host checks included) over a real socket, with a fake llama-server.
func chatServer(t *testing.T, model http.HandlerFunc) (*httptest.Server, *store.Store) {
	t.Helper()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/props" {
			fmt.Fprint(w, `{"default_generation_settings":{"n_ctx":8192}}`)
			return
		}
		model(w, r)
	}))
	t.Cleanup(backend.Close)
	st, err := store.Open(t.TempDir(), event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc := &chat.Service{Store: st, Router: &stubRouter{baseURL: backend.URL}, Sizes: &prompt.ContextSizes{}}

	// The Host check wants the port core listens on, which is only known once the listener exists.
	srv := httptest.NewUnstartedServer(nil)
	port := srv.Listener.Addr().(interface{ String() string }).String()
	var p int
	fmt.Sscanf(port[strings.LastIndex(port, ":")+1:], "%d", &p)
	srv.Config.Handler = testHandler(Deps{Port: p, Chats: svc})
	srv.Start()
	t.Cleanup(srv.Close)
	return srv, st
}

func call(t *testing.T, srv *httptest.Server, method, path, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func readBody(r *http.Response) string { b, _ := io.ReadAll(r.Body); return string(b) }

func TestChatCRUDAndExport(t *testing.T) {
	srv, st := chatServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n")
	})
	resp := call(t, srv, "POST", "/api/chats", `{"model":"qwen"}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, readBody(resp))
	}
	chats, _ := st.ListChats(context.Background())
	if len(chats) != 0 {
		t.Fatal("an empty chat must not be listed")
	}
	// Fish the id out of the response body.
	body := readBody(resp)
	id := body[strings.Index(body, `"id":"`)+6:]
	id = id[:strings.Index(id, `"`)]

	if r := call(t, srv, "POST", "/api/chats", `{}`); r.StatusCode != 400 {
		t.Fatalf("create without model: %d", r.StatusCode)
	}
	if r := call(t, srv, "POST", "/api/chats/"+id+"/messages", `{"text":"hi"}`); r.StatusCode != 200 {
		t.Fatalf("send: %d", r.StatusCode)
	} else {
		readBody(r)
	}
	if r := call(t, srv, "PATCH", "/api/chats/"+id, `{"title":"Mine"}`); r.StatusCode != 200 || !strings.Contains(readBody(r), `"titleSource":"user"`) {
		t.Fatalf("patch: %d", r.StatusCode)
	}
	r := call(t, srv, "GET", "/api/chats/"+id, "")
	if b := readBody(r); !strings.Contains(b, `"messages"`) || !strings.Contains(b, "hello") {
		t.Fatalf("get: %s", b)
	}
	r = call(t, srv, "GET", "/api/chats/"+id+"/export", "")
	if b := readBody(r); !strings.Contains(b, "# Mine") || !strings.Contains(b, "hello") {
		t.Fatalf("export: %s", b)
	}
	if r := call(t, srv, "GET", "/api/chats", ""); !strings.Contains(readBody(r), id) {
		t.Fatal("chat missing from the list")
	}
	if r := call(t, srv, "DELETE", "/api/chats/"+id, ""); r.StatusCode != 204 {
		t.Fatalf("delete: %d", r.StatusCode)
	}
	if r := call(t, srv, "GET", "/api/chats/"+id, ""); r.StatusCode != 404 {
		t.Fatalf("get after delete: %d", r.StatusCode)
	}
}

func TestSendStreamsServerSentEvents(t *testing.T) {
	srv, st := chatServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\\nb\"}}]}\n\ndata: [DONE]\n\n")
	})
	c, _ := st.CreateChat(context.Background(), "qwen", false)
	resp := call(t, srv, "POST", "/api/chats/"+c.ID+"/messages", `{"text":"hi"}`)
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	var events []string
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if name, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
			events = append(events, name)
		}
		if strings.HasPrefix(sc.Text(), "data: ") && strings.Contains(sc.Text(), "\n") {
			t.Fatal("a data line must not contain a raw newline")
		}
	}
	if got := strings.Join(events, ","); got != "start,status,delta,done" {
		t.Fatalf("events = %s", got)
	}
}

func TestSendErrorsBeforeTheStreamAreJSON(t *testing.T) {
	srv, st := chatServer(t, func(http.ResponseWriter, *http.Request) {})
	c, _ := st.CreateChat(context.Background(), "qwen", false)
	if r := call(t, srv, "POST", "/api/chats/nope/messages", `{"text":"hi"}`); r.StatusCode != 404 {
		t.Fatalf("unknown chat: %d", r.StatusCode)
	}
	if r := call(t, srv, "POST", "/api/chats/"+c.ID+"/messages", `{"text":""}`); r.StatusCode != 400 {
		t.Fatalf("empty text: %d", r.StatusCode)
	}
	if r := call(t, srv, "POST", "/api/chats/"+c.ID+"/regenerate", ``); r.StatusCode != 400 {
		t.Fatalf("regenerate on empty chat: %d", r.StatusCode)
	}
}

func TestChatEndpointsWithoutStorageAnswer503(t *testing.T) {
	rows := []struct{ method, path, body string }{
		{"GET", "/api/chats", ""},
		{"POST", "/api/chats", `{"model":"qwen"}`},
		{"GET", "/api/chats/c1", ""},
		{"PATCH", "/api/chats/c1", `{"title":"x"}`},
		{"DELETE", "/api/chats/c1", ""},
		{"GET", "/api/chats/c1/export", ""},
		{"POST", "/api/chats/c1/messages", `{"text":"hi"}`},
		{"POST", "/api/chats/c1/regenerate", ""},
	}
	for _, row := range rows {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(row.method, row.path, strings.NewReader(row.body))
		req.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
		req.Header.Set("Authorization", "Bearer "+testToken)
		testHandler(Deps{}).ServeHTTP(rec, req)
		if rec.Code != 503 || !strings.Contains(rec.Body.String(), `"error":"chat_unavailable"`) {
			t.Errorf("%s %s: %d %s", row.method, row.path, rec.Code, rec.Body)
		}
	}
}

func TestCreateChatBodyErrors(t *testing.T) {
	srv, _ := chatServer(t, func(http.ResponseWriter, *http.Request) {})
	cases := []struct{ body, code string }{
		{`{}`, "invalid_request"},
		{`{"model":""}`, "bad_request"},
		{`{"model":"qwen","colour":"red"}`, "invalid_request"},
	}
	for _, c := range cases {
		r := call(t, srv, "POST", "/api/chats", c.body)
		if b := readBody(r); r.StatusCode != 400 || !strings.Contains(b, `"error":"`+c.code+`"`) {
			t.Errorf("body %s: %d %s, want 400 %s", c.body, r.StatusCode, b, c.code)
		}
	}
}

func TestEmptyChatListIsArrayAndDeleteHasNoBody(t *testing.T) {
	srv, st := chatServer(t, func(http.ResponseWriter, *http.Request) {})
	if r := call(t, srv, "GET", "/api/chats", ""); strings.TrimSpace(readBody(r)) != "[]" {
		t.Fatal("an empty list must be []")
	}
	c, _ := st.CreateChat(context.Background(), "qwen", false)
	r := call(t, srv, "DELETE", "/api/chats/"+c.ID, "")
	if b := readBody(r); r.StatusCode != 204 || b != "" {
		t.Fatalf("delete: %d %q", r.StatusCode, b)
	}
}
