package event

import "encoding/json"

// ConfigChanged says a config section was written; Rev is the section's new revision.
type ConfigChanged struct {
	Section string `json:"section"`
	Rev     int    `json:"rev"`
}

func (ConfigChanged) EventType() Type { return Type{Name: "config.changed", V: 1, Class: Durable} }

// ModelState is the models list as GET /api/state shows it; Models is that JSON array.
type ModelState struct {
	Models json.RawMessage `json:"models"`
}

func (ModelState) EventType() Type { return Type{Name: "model.state", V: 1, Class: Retained} }

// DownloadProgress is the download queue; Items is the JSON array of its items.
type DownloadProgress struct {
	Items json.RawMessage `json:"items"`
}

func (DownloadProgress) EventType() Type {
	return Type{Name: "download.progress", V: 1, Class: Retained}
}

// Types lists every payload type. A new type is added here and to api's eventDocs (a test checks both).
var Types = []Payload{ConfigChanged{}, ModelState{}, DownloadProgress{}}
