package event

// ConfigChanged says a config section was written; Rev is the section's new revision.
type ConfigChanged struct {
	Section string `json:"section"`
	Rev     int    `json:"rev"`
}

func (ConfigChanged) EventType() Type { return Type{Name: "config.changed", V: 1, Class: Durable} }
