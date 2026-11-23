// Package feed turns the signals of the provider and the download queue into retained events on the bus, from one
// place, so every stream shows the same state.
package feed

import (
	"context"
	"encoding/json"
	"path/filepath"
	"time"

	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/fit"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/provider"
)

// Downloads is the part of the download queue feed reads.
type Downloads interface {
	Items() []downloads.DownloadItem
	Subscribe() (<-chan struct{}, func())
}

const StateStopped = "stopped"

// Model is what the provider knows about a model plus facts from disk.
// The embedded struct's fields are flattened into the same JSON object.
type Model struct {
	provider.ModelState
	SizeBytes int64 `json:"sizeBytes"`
	// Projector is the detected vision projector's file name (never its path); left out when there is none.
	Projector string `json:"projector,omitempty"`
	// Kind is chat, embedding or unreadable, read from the GGUF header; Error says why a file is unreadable.
	Kind  models.Kind `json:"kind" enum:"chat,embedding,unreadable"`
	Error string      `json:"error,omitempty"`
	// Context is the size and placement the model loads with (fit's choice or the user's own); null for a model that
	// is not a chat model.
	Context *fit.Choice `json:"context"`
	// MoE is true for a chat model with expert tensors: only those can place experts on the CPU.
	MoE bool `json:"moe"`
	// Name is the catalog's name, the header's general.name or the file name, in that order.
	Name  string   `json:"name"`
	Quant *string  `json:"quant" doc:"null when the file name has no quantisation label"`
	Tags  []string `json:"tags" doc:"Code, Vision, MoE, Embeddings, in that order"`
}

// DownloadsBody is the JSON of GET /api/downloads and the data of the downloads event.
type DownloadsBody struct {
	Items []downloads.DownloadItem `json:"items"`
}

// StateBody is the JSON of GET /api/models.
type StateBody struct {
	Models []Model `json:"models"`
}

// State lists every model on disk: what the provider knows about it, or
// "stopped" when it has never been touched or has been unloaded.
func State(res provider.Resident, list func() ([]models.Model, error), choose func(models.Model) *fit.Choice) (StateBody, error) {
	found, err := list()
	if err != nil {
		return StateBody{}, err
	}
	known := map[string]provider.ModelState{}
	for _, m := range res.States() {
		known[m.ID] = m
	}
	out := make([]Model, 0, len(found)) // [] rather than null when empty
	for _, m := range found {
		st, ok := known[m.ID]
		if !ok {
			st = provider.ModelState{ID: m.ID, State: StateStopped}
		}
		projector := ""
		if m.MMProj != "" {
			projector = filepath.Base(m.MMProj)
		}
		// Both the provider and the header can have an error; the outer field shadows the embedded one in JSON, so merge.
		errText := st.Error
		if errText == "" {
			errText = m.Error
		}
		var choice *fit.Choice
		if choose != nil {
			choice = choose(m)
		}
		var quant *string
		if m.Quant != "" {
			quant = &m.Quant
		}
		tags := m.Tags
		if tags == nil {
			tags = []string{} // [] rather than null
		}
		out = append(out, Model{ModelState: st, SizeBytes: m.SizeBytes, Projector: projector, Kind: m.Kind, Error: errText,
			Context: choice, MoE: m.Kind == models.KindChat && fit.MoE(m.Shape), Name: m.Name, Quant: quant, Tags: tags})
	}
	return StateBody{Models: out}, nil
}

// downloadsInterval keeps download.progress to 4 a second: progress changes with every chunk.
const downloadsInterval = 250 * time.Millisecond

// Start publishes the model state, and the download progress when dl is not nil, now and after every signal until
// ctx ends. It returns at once. A failing scan publishes nothing: the bus keeps the last value, and GET /api/models
// shows the error.
func Start(ctx context.Context, log event.Log, res provider.Resident, list func() ([]models.Model, error), choose func(models.Model) *fit.Choice, dl Downloads) {
	// Subscribe before the first scan, so a change in between is not lost.
	changed, cancel := res.Subscribe()
	// A nil channel never fires, so without a downloads source its cases below simply never run.
	var dlChanged <-chan struct{}
	cancelDL := func() {}
	if dl != nil {
		dlChanged, cancelDL = dl.Subscribe()
	}
	go func() {
		defer cancel()
		defer cancelDL()
		publish := func() {
			body, err := State(res, list, choose)
			if err != nil {
				return
			}
			data, _ := json.Marshal(body.Models)
			log.Publish("system", event.ModelState{Models: data})
		}
		var lastDL time.Time
		publishDL := func() {
			lastDL = time.Now()
			data, _ := json.Marshal(dl.Items())
			log.Publish("system", event.DownloadProgress{Items: data})
		}
		publish()
		if dl != nil {
			publishDL()
		}
		var timer *time.Timer
		var timerC <-chan time.Time // nil while no timer is pending
		defer func() {
			if timer != nil {
				timer.Stop()
			}
		}()
		for {
			select {
			case <-changed:
				if ctx.Err() != nil { // both were ready and select picked the signal
					return
				}
				publish()
			case <-dlChanged:
				if ctx.Err() != nil {
					return
				}
				// A change inside the pause is not dropped: the timer publishes the newest items when it is over.
				if wait := downloadsInterval - time.Since(lastDL); wait > 0 {
					if timerC == nil {
						timer = time.NewTimer(wait)
						timerC = timer.C
					}
				} else {
					publishDL()
				}
			case <-timerC:
				timerC = nil
				publishDL()
			case <-ctx.Done():
				return
			}
		}
	}()
}
