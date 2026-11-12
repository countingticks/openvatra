package event

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestValidStream(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"system", true},
		{"chat:ab12", true},
		{"run:A-9", true},
		{"", false},
		{"chat:", false},
		{":a", false},
		{"Chat:a", false},
		{"chat:a b", false},
		{"chat:a:b", false},
		{"systemx", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValidStream(tt.name); got != tt.want {
				t.Errorf("ValidStream(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestNewFillsEnvelopeFromPayload(t *testing.T) {
	at := time.UnixMilli(1_700_000_000_123)
	e := New("system", ConfigChanged{Section: "models", Rev: 4}, at)

	if e.Seq != 0 || e.Time != at.UnixMilli() || e.Stream != "system" || e.Type != "config.changed" || e.V != 1 {
		t.Fatalf("envelope = %+v", e)
	}
	if string(e.Data) != `{"section":"models","rev":4}` {
		t.Errorf("Data = %s", e.Data)
	}
	if e.Class() != Durable {
		t.Errorf("Class = %v, want Durable", e.Class())
	}
	out, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `"seq"`) {
		t.Errorf("JSON has seq: %s", out)
	}
}

func TestNewPanicsOnInvalidStream(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("New did not panic")
		}
	}()
	New("Chat:a", ConfigChanged{}, time.Now())
}

func TestZeroClassIsDurable(t *testing.T) {
	if got := (Event{Stream: "system", Type: "config.changed"}).Class(); got != Durable {
		t.Errorf("Class = %v, want Durable", got)
	}
}
