package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

// keepaliveInterval is how often an idle stream sends a comment line, so proxies and clients see it is alive.
const keepaliveInterval = 15 * time.Second

// catchUpPage is how many stored events one Read returns while a client catches up from its bookmark.
const catchUpPage = 500

// eventsHandler streams the event log as Server-Sent Events: a hello frame, the stored events after the client's
// bookmark, the retained values, then everything published live. Only hello has an "event:" line; every log event
// is a default message whose data is the envelope, with "id: <seq>" when it is durable.
func eventsHandler(log event.Log, keepalive time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		hasAfter := q.Has("after")
		var after int64
		if hasAfter {
			n, err := strconv.ParseInt(q.Get("after"), 10, 64)
			if err != nil || n < 0 {
				writeError(w, http.StatusBadRequest, "invalid_after", "after must be an integer of 0 or more")
				return
			}
			after = n
		}
		filter, err := event.ParseFilter(q.Get("stream"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_filter", err.Error())
			return
		}
		logID := q.Get("log")

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "no_streaming", "streaming is not supported")
			return
		}
		// Subscribe before Info: an event appended in between is then both at or below head and in the channel,
		// and the dedupe below drops it, instead of being in neither.
		retained, events, cancel := log.Subscribe(filter)
		defer cancel()
		ctx := r.Context()
		info, err := log.Info(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "event_log_failed", "could not read the event log")
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		write := func(frame string) bool {
			if _, err := fmt.Fprint(w, frame); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}
		writeEvent := func(e event.Event) bool {
			data, err := json.Marshal(e) // one line: Data was marshalled by encoding/json and is compacted again
			if err != nil {
				return false
			}
			if e.Seq > 0 {
				return write(fmt.Sprintf("id: %d\ndata: %s\n\n", e.Seq, data))
			}
			return write(fmt.Sprintf("data: %s\n\n", data))
		}

		reset := (logID != "" && logID != info.ID) || (hasAfter && after > info.Head)
		hello, _ := json.Marshal(struct {
			Log   string `json:"log"`
			Head  int64  `json:"head"`
			Reset bool   `json:"reset"`
		}{info.ID, info.Head, reset})
		if !write(fmt.Sprintf("event: hello\ndata: %s\n\n", hello)) {
			return
		}

		// last is the dedupe mark: a durable event at or below it was already sent, or lies before the bookmark the
		// client starts from.
		last := info.Head
		if hasAfter && !reset {
			cursor := after
			for {
				page, err := log.Read(ctx, cursor, filter, catchUpPage)
				if err != nil {
					return // the client reconnects with its bookmark
				}
				for _, e := range page {
					if !writeEvent(e) {
						return
					}
					cursor = e.Seq
				}
				if len(page) < catchUpPage {
					break
				}
			}
			last = cursor
		}

		for _, e := range retained {
			if !writeEvent(e) {
				return
			}
		}

		ticker := time.NewTicker(keepalive)
		defer ticker.Stop()
		for {
			select {
			case e, ok := <-events:
				if !ok {
					return // fell behind: the client reconnects with its bookmark
				}
				if e.Seq > 0 {
					if e.Seq <= last {
						continue
					}
					last = e.Seq
				}
				if !writeEvent(e) {
					return
				}
			case <-ticker.C:
				if !write(": keepalive\n\n") {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}
}
