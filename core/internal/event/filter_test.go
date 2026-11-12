package event

import (
	"slices"
	"strings"
	"testing"
)

func streams(n int) string {
	items := make([]string, n)
	for i := range items {
		items[i] = "system"
	}
	return strings.Join(items, ",")
}

func TestParseFilterAccepts(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"system", "system", []string{"system"}},
		{"list", "chat:ab12,system", []string{"chat:ab12", "system"}},
		{"kind wildcard", "run:*", []string{"run:*"}},
		{"32 items", streams(32), strings.Split(streams(32), ",")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, err := ParseFilter(tt.in)
			if err != nil {
				t.Fatalf("ParseFilter(%q): %v", tt.in, err)
			}
			if !slices.Equal(f.Streams, tt.want) {
				t.Errorf("Streams = %v, want %v", f.Streams, tt.want)
			}
		})
	}
}

func TestParseFilterRejects(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantMsg string
	}{
		{"empty item", "system,,chat:a", `""`},
		{"trailing comma", "system,", `""`},
		{"space", "chat:a, system", `" system"`},
		{"upper-case kind", "Chat:*", `"Chat:*"`},
		{"two colons", "chat:a:b", `"chat:a:b"`},
		{"33 items", streams(33), "at most 32 streams"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseFilter(tt.in)
			if err == nil {
				t.Fatalf("ParseFilter(%q) gave no error", tt.in)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("error %q does not contain %s", err, tt.wantMsg)
			}
		})
	}
}

func TestFilterMatch(t *testing.T) {
	tests := []struct {
		name    string
		streams []string
		stream  string
		want    bool
	}{
		{"empty matches system", nil, "system", true},
		{"empty matches chat", nil, "chat:a", true},
		{"exact", []string{"chat:a"}, "chat:a", true},
		{"exact other id", []string{"chat:a"}, "chat:b", false},
		{"kind matches id", []string{"kind:*"}, "kind:a", true},
		{"kind not system", []string{"kind:*"}, "system", false},
		{"kind not longer kind", []string{"kind:*"}, "kindx:a", false},
		{"second item", []string{"chat:a", "system"}, "system", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := (Filter{Streams: tt.streams}).Match(tt.stream); got != tt.want {
				t.Errorf("Match(%q) = %v, want %v", tt.stream, got, tt.want)
			}
		})
	}
}
