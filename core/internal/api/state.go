package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/countingticks/openvatra/core/internal/feed"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

// downloadsInterval keeps the downloads event to 4 a second.
const downloadsInterval = 250 * time.Millisecond

func stateHandler(rt Router, list func() ([]models.Model, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		body, err := feed.State(rt, list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "models_unreadable", "could not read the models folder")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}
}

// eventsHandler streams Server-Sent Events: the current state at once, then a new
// one after every change, so Electron main never has to poll. An SSE message is
// plain text, "event: <name>", "data: <one line>", and a blank line to end it.
func eventsHandler(rt Router, list func() ([]models.Model, error), dl Downloads, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeError(w, http.StatusInternalServerError, "no_streaming", "streaming is not supported")
			return
		}
		// Subscribe before the first read, so a change in between is not lost.
		changed, cancel := rt.Subscribe()
		defer cancel()

		// Config changes: the subscriber only records the newest rev per section and signals, so a Put never waits
		// on this stream; two quick writes may arrive as one event with the later rev. A nil channel never fires.
		var cfgChanged chan struct{}
		var pending map[string]int
		var pendingMu sync.Mutex
		if cfg != nil {
			cfgChanged = make(chan struct{}, 1)
			pending = map[string]int{}
			cancelCfg := cfg.Subscribe(func(section string, rev int) {
				pendingMu.Lock()
				pending[section] = rev
				pendingMu.Unlock()
				select {
				case cfgChanged <- struct{}{}:
				default:
				}
			})
			defer cancelCfg()
		}
		sendConfig := func() bool {
			pendingMu.Lock()
			batch := pending
			pending = map[string]int{}
			pendingMu.Unlock()
			names := make([]string, 0, len(batch))
			for name := range batch {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				data, _ := json.Marshal(struct {
					Section string `json:"section"`
					Rev     int    `json:"rev"`
				}{name, batch[name]})
				if _, err := fmt.Fprintf(w, "event: config\ndata: %s\n\n", data); err != nil {
					return false
				}
			}
			flusher.Flush()
			return true
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		send := func() bool {
			body, err := feed.State(rt, list)
			if err != nil {
				return true // keep the stream; the next change may succeed
			}
			data, _ := json.Marshal(body) // json.Marshal emits a single line
			if _, err := fmt.Fprintf(w, "event: state\ndata: %s\n\n", data); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}

		if !send() {
			return
		}
		// A nil channel never fires, so without a downloads source its cases below simply never run.
		var dlChanged <-chan struct{}
		var sendDL func() bool
		var dlTimer <-chan time.Time
		var lastDL time.Time
		if dl != nil {
			var cancelDL func()
			dlChanged, cancelDL = dl.Subscribe()
			defer cancelDL()
			sendDL = func() bool {
				lastDL = time.Now()
				data, _ := json.Marshal(map[string]any{"items": dl.Items()})
				if _, err := fmt.Fprintf(w, "event: downloads\ndata: %s\n\n", data); err != nil {
					return false
				}
				flusher.Flush()
				return true
			}
			if !sendDL() {
				return
			}
		}
		for {
			select {
			case <-changed:
				if !send() {
					return
				}
			case <-cfgChanged:
				if !sendConfig() {
					return
				}
			case <-dlChanged:
				// At most 4 a second: progress changes with every chunk. A change inside the pause is not
				// dropped, the timer sends the newest state when the pause is over.
				if wait := downloadsInterval - time.Since(lastDL); wait > 0 {
					if dlTimer == nil {
						dlTimer = time.After(wait)
					}
				} else if !sendDL() {
					return
				}
			case <-dlTimer:
				dlTimer = nil
				if !sendDL() {
					return
				}
			case <-r.Context().Done():
				return
			}
		}
	}
}

// loadHandler loads a model and answers once it is ready.
func loadHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := rt.Load(r.Context(), r.PathValue("id")); err != nil {
			writeAcquireError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": router.StateReady})
	}
}

// unloadHandler asks for a model to be unloaded. 202 because the server may
// still be finishing a reply and stops in the background.
// refreshHandler tells every listener to re-read the models folder. For changes core can't see itself: main moves a
// removed model to the Recycle Bin, and the list has to drop it.
func refreshHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		rt.Notify()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "refreshing"})
	}
}

func unloadHandler(rt Router) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rt.Unload(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "model_not_loaded", "that model is not loaded")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": feed.StateStopped})
	}
}
