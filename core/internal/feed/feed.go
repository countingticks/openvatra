// Package feed turns the signals of the router and the download queue into retained events on the bus, from one
// place, so every stream shows the same state.
package feed

import (
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/router"
)

// Router is the part of the model router feed reads.
type Router interface {
	Snapshot() []router.ModelState
	Subscribe() (<-chan struct{}, func())
}

// Downloads is the part of the download queue feed reads.
type Downloads interface {
	Items() []downloads.Item
	Subscribe() (<-chan struct{}, func())
}

const StateStopped = "stopped"

// Model is what the router knows about a model plus facts from disk.
// The embedded struct's fields are flattened into the same JSON object.
type Model struct {
	router.ModelState
	SizeBytes int64 `json:"sizeBytes"`
	// Projector is the detected vision projector's file name (never its path); left out when there is none.
	Projector string `json:"projector,omitempty"`
	// Kind is chat, embedding or unreadable, read from the GGUF header; Error says why a file is unreadable.
	Kind  models.Kind `json:"kind"`
	Error string      `json:"error,omitempty"`
}

// StateBody is the JSON of GET /api/state.
type StateBody struct {
	Models []Model `json:"models"`
}

// State lists every model on disk: what the router knows about it, or
// "stopped" when it has never been touched or has been unloaded.
func State(rt Router, list func() ([]models.Model, error)) (StateBody, error) {
	found, err := list()
	if err != nil {
		return StateBody{}, err
	}
	known := map[string]router.ModelState{}
	for _, m := range rt.Snapshot() {
		known[m.ID] = m
	}
	out := make([]Model, 0, len(found)) // [] rather than null when empty
	for _, m := range found {
		st, ok := known[m.ID]
		if !ok {
			st = router.ModelState{ID: m.ID, State: StateStopped}
		}
		projector := ""
		if m.MMProj != "" {
			projector = filepath.Base(m.MMProj)
		}
		// Both the router and the header can have an error; the outer field shadows the embedded one in JSON, so merge.
		errText := st.Error
		if errText == "" {
			errText = m.Error
		}
		out = append(out, Model{ModelState: st, SizeBytes: m.SizeBytes, Projector: projector, Kind: m.Kind, Error: errText})
	}
	return StateBody{Models: out}, nil
}

// Start publishes the model state now and after every router signal until ctx ends. It returns at once. A failing
// scan publishes nothing: the bus keeps the last value, and GET /api/state shows the error.
func Start(ctx context.Context, log event.Log, rt Router, list func() ([]models.Model, error), dl Downloads) {
	// Subscribe before the first scan, so a change in between is not lost.
	changed, cancel := rt.Subscribe()
	go func() {
		defer cancel()
		publish := func() {
			body, err := State(rt, list)
			if err != nil {
				return
			}
			data, _ := json.Marshal(body.Models)
			log.Publish("system", event.ModelState{Models: data})
		}
		publish()
		for {
			select {
			case <-changed:
				if ctx.Err() != nil { // both were ready and select picked the signal
					return
				}
				publish()
			case <-ctx.Done():
				return
			}
		}
	}()
}
