package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/store"
)

const testKeepalive = 50 * time.Millisecond

// storeLog opens a real SQLite log in a temporary folder.
func storeLog(t *testing.T) event.Log {
	t.Helper()
	return storeLogWithBuffer(t, 64)
}

// storeLogWithBuffer is storeLog with a chosen bus buffer per subscriber.
func storeLogWithBuffer(t *testing.T, buffer int) event.Log {
	t.Helper()
	db, err := store.Open(t.TempDir(), event.NewBus(buffer))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db.Log()
}

func appendConfig(t *testing.T, log event.Log, stream string, n int) {
	t.Helper()
	payloads := make([]event.Payload, n)
	for i := range payloads {
		payloads[i] = event.ConfigChanged{Section: "models", Rev: i + 1}
	}
	if _, err := log.Append(context.Background(), stream, payloads...); err != nil {
		t.Fatal(err)
	}
}

func publishModels(log event.Log) {
	log.Publish("system", event.ModelState{Models: json.RawMessage(`[{"id":"a"}]`)})
}

func eventsServer(t *testing.T, log event.Log) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(eventsHandler(log, testKeepalive))
	t.Cleanup(srv.Close)
	return srv
}

// openStream connects to srv with query and returns its frames as they arrive, the lines of each joined by "|".
// Keepalives are dropped unless keepalives is true. The channel closes when the response ends.
func openStream(t *testing.T, srv *httptest.Server, query string, keepalives bool) <-chan string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/?"+query, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status %d, Content-Type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	out := make(chan string, 2048)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		var lines []string
		for sc.Scan() {
			if sc.Text() != "" {
				lines = append(lines, sc.Text())
				continue
			}
			frame := strings.Join(lines, "|")
			lines = nil
			if frame == ": keepalive" && !keepalives {
				continue
			}
			out <- frame
		}
	}()
	return out
}

func nextEvent(t *testing.T, events <-chan string) string {
	t.Helper()
	select {
	case e, ok := <-events:
		if !ok {
			t.Fatal("stream ended")
		}
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("no event")
		return ""
	}
}

func expectNoEvent(t *testing.T, events <-chan string) {
	t.Helper()
	select {
	case e := <-events:
		t.Fatalf("unexpected event %q", e)
	case <-time.After(300 * time.Millisecond):
	}
}

func expectEnd(t *testing.T, events <-chan string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case e, ok := <-events:
			if !ok {
				return
			}
			t.Fatalf("unexpected event %q before the end", e)
		case <-deadline:
			t.Fatal("stream did not end")
		}
	}
}

func helloFrame(id string, head int64, reset bool) string {
	return fmt.Sprintf(`event: hello|data: {"log":%q,"head":%d,"reset":%t}`, id, head, reset)
}

// logEvent splits a log event frame into its "id:" value ("" when absent) and its envelope.
func logEvent(t *testing.T, frame string) (string, event.Event) {
	t.Helper()
	id := ""
	data, ok := strings.CutPrefix(frame, "data: ")
	if !ok {
		var rest string
		id, rest, _ = strings.Cut(strings.TrimPrefix(frame, "id: "), "|")
		if data, ok = strings.CutPrefix(rest, "data: "); !ok || !strings.HasPrefix(frame, "id: ") {
			t.Fatalf("not a log event: %q", frame)
		}
	}
	var e event.Event
	if err := json.Unmarshal([]byte(data), &e); err != nil {
		t.Fatalf("frame %q: %v", frame, err)
	}
	return id, e
}

// expectSeqs reads durable frames until it has seen seq to, and fails unless they are from+1…to, once each, in order.
func expectSeqs(t *testing.T, events <-chan string, from, to int64) {
	t.Helper()
	for want := from + 1; want <= to; want++ {
		id, e := logEvent(t, nextEvent(t, events))
		if e.Seq != want || id != strconv.FormatInt(want, 10) {
			t.Fatalf("got id %q seq %d, want %d", id, e.Seq, want)
		}
	}
}

func expectRetained(t *testing.T, events <-chan string) {
	t.Helper()
	id, e := logEvent(t, nextEvent(t, events))
	if id != "" || e.Seq != 0 || e.Type != "model.state" || e.Stream != "system" || string(e.Data) != `{"models":[{"id":"a"}]}` {
		t.Fatalf("retained frame: id %q, event %+v", id, e)
	}
}

func logInfo(t *testing.T, log event.Log) event.Info {
	t.Helper()
	info, err := log.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func TestEventsWithoutQueryStartLiveFromHead(t *testing.T) {
	log := storeLog(t)
	appendConfig(t, log, "system", 1)
	publishModels(log)
	events := openStream(t, eventsServer(t, log), "", false)

	info := logInfo(t, log)
	if info.ID == "" {
		t.Fatal("the store's log has no id")
	}
	if got := nextEvent(t, events); got != helloFrame(info.ID, 1, false) {
		t.Fatalf("hello = %q", got)
	}
	expectRetained(t, events)
	appendConfig(t, log, "system", 1)
	expectSeqs(t, events, 1, 2)
}

func TestEventsCatchUpFromAfter(t *testing.T) {
	log := storeLog(t)
	appendConfig(t, log, "system", 3)
	publishModels(log)
	events := openStream(t, eventsServer(t, log), "after=1", false)

	if got := nextEvent(t, events); got != helloFrame(logInfo(t, log).ID, 3, false) {
		t.Fatalf("hello = %q", got)
	}
	expectSeqs(t, events, 1, 3)
	expectRetained(t, events)
	appendConfig(t, log, "system", 1)
	expectSeqs(t, events, 3, 4)
}

func TestEventsResetSkipsCatchUp(t *testing.T) {
	cases := []struct{ name, query string }{
		{"after past head", "after=9"},
		{"another log", "after=0&log=other"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			log := storeLog(t)
			appendConfig(t, log, "system", 3)
			publishModels(log)
			events := openStream(t, eventsServer(t, log), c.query, false)

			if got := nextEvent(t, events); got != helloFrame(logInfo(t, log).ID, 3, true) {
				t.Fatalf("hello = %q", got)
			}
			expectRetained(t, events) // straight after hello: no catch-up
			appendConfig(t, log, "system", 1)
			expectSeqs(t, events, 3, 4)
		})
	}
}

func TestEventsCatchUpAcrossPages(t *testing.T) {
	log := storeLog(t)
	appendConfig(t, log, "system", 1200)
	events := openStream(t, eventsServer(t, log), "after=0", false)

	nextEvent(t, events) // hello
	expectSeqs(t, events, 0, 1200)
	expectNoEvent(t, events)
}

func TestEventsAppendRacingTheAttachIsSentOnce(t *testing.T) {
	// Room for every append: while the handler catches up it does not drain its channel, and a full one would end
	// the stream (fell behind, tested on its own), which is not what this test is about.
	log := storeLogWithBuffer(t, 256)
	srv := eventsServer(t, log)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 200; i++ {
			if _, err := log.Append(context.Background(), "system", event.ConfigChanged{Section: "models", Rev: i + 1}); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	events := openStream(t, srv, "after=0", false)

	nextEvent(t, events) // hello
	expectSeqs(t, events, 0, 200)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	expectNoEvent(t, events)
}

func TestEventsFilterByStream(t *testing.T) {
	log := storeLog(t)
	publishModels(log)
	events := openStream(t, eventsServer(t, log), "stream="+"chat:*", false)

	nextEvent(t, events) // hello
	appendConfig(t, log, "system", 1)
	appendConfig(t, log, "chat:a", 1)
	_, e := logEvent(t, nextEvent(t, events))
	if e.Stream != "chat:a" || e.Seq != 2 {
		t.Fatalf("first event after hello = %+v, want the chat:a append", e)
	}
	expectNoEvent(t, events)
}

func TestEventsRejectBadQueries(t *testing.T) {
	srv := eventsServer(t, storeLog(t))
	cases := []struct{ query, code string }{
		{"after=-1", "invalid_after"},
		{"after=x", "invalid_after"},
		{"after=", "invalid_after"},
		{"stream=bad%20name", "invalid_filter"},
	}
	for _, c := range cases {
		t.Run(c.query, func(t *testing.T) {
			resp, err := http.Get(srv.URL + "/?" + c.query)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var body struct {
				Error string `json:"error"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&body)
			if resp.StatusCode != http.StatusBadRequest || body.Error != c.code {
				t.Fatalf("status %d, error %q; want 400 %q", resp.StatusCode, body.Error, c.code)
			}
		})
	}
}

func TestEventsSendKeepalives(t *testing.T) {
	events := openStream(t, eventsServer(t, storeLog(t)), "", true)
	nextEvent(t, events) // hello
	select {
	case got := <-events:
		if got != ": keepalive" {
			t.Fatalf("frame = %q, want a keepalive", got)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("no keepalive within 200 ms")
	}
}

// fellBehindLog is a real log whose live channel the test closes, the way the bus does for a slow subscriber.
type fellBehindLog struct {
	event.Log
	live chan event.Event
}

func (l fellBehindLog) Subscribe(f event.Filter) ([]event.Event, <-chan event.Event, func()) {
	retained, _, cancel := l.Log.Subscribe(f)
	return retained, l.live, cancel
}

func TestEventsFellBehindEndsTheResponseAndAReconnectCatchesUp(t *testing.T) {
	log := storeLog(t)
	appendConfig(t, log, "system", 1)
	behind := fellBehindLog{Log: log, live: make(chan event.Event)}
	events := openStream(t, eventsServer(t, behind), "after=0", false)

	nextEvent(t, events) // hello
	id, _ := logEvent(t, nextEvent(t, events))
	close(behind.live)
	expectEnd(t, events)

	appendConfig(t, log, "system", 2)
	events = openStream(t, eventsServer(t, log), "after="+id, false)
	nextEvent(t, events) // hello
	expectSeqs(t, events, 1, 3)
}

func TestEventsWithMemoryLog(t *testing.T) {
	log := event.MemoryLog(event.NewBus(16))
	publishModels(log)
	events := openStream(t, eventsServer(t, log), "", false)

	if got := nextEvent(t, events); got != `event: hello|data: {"log":"","head":0,"reset":false}` {
		t.Fatalf("hello = %q", got)
	}
	expectRetained(t, events)
}
