package event

import (
	"slices"
	"testing"
)

func TestInputParts(t *testing.T) {
	tests := []struct {
		name   string
		text   string
		quotes []string
		want   []MessagePart
	}{
		{"with a quote", "t", []string{"q"}, []MessagePart{{Kind: "quote", Text: "q"}, {Kind: "text", Text: "t"}}},
		{"InputParts puts every quote first, in order", "t", []string{"q1", "q2"},
			[]MessagePart{{Kind: "quote", Text: "q1"}, {Kind: "quote", Text: "q2"}, {Kind: "text", Text: "t"}}},
		{"without", "t", nil, []MessagePart{{Kind: "text", Text: "t"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := InputParts(tt.text, tt.quotes); !slices.Equal(got, tt.want) {
				t.Errorf("InputParts = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestQuotesOf(t *testing.T) {
	t.Run("QuotesOf lists the quote parts in order", func(t *testing.T) {
		if got := QuotesOf(InputParts("t", []string{"q1", "q2"})); !slices.Equal(got, []string{"q1", "q2"}) {
			t.Errorf("QuotesOf = %q, want [q1 q2]", got)
		}
	})
	t.Run("nil without a quote", func(t *testing.T) {
		if got := QuotesOf(InputParts("t", nil)); got != nil {
			t.Errorf("QuotesOf without a quote = %q", got)
		}
	})
}
