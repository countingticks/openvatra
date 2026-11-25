package event

import (
	"slices"
	"testing"
)

func TestInputPartsPutsTheQuoteFirstAndLeavesItOutWhenEmpty(t *testing.T) {
	tests := []struct {
		name        string
		text, quote string
		want        []MessagePart
	}{
		{"with a quote", "t", "q", []MessagePart{{Kind: "quote", Text: "q"}, {Kind: "text", Text: "t"}}},
		{"without", "t", "", []MessagePart{{Kind: "text", Text: "t"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := InputParts(tt.text, tt.quote); !slices.Equal(got, tt.want) {
				t.Errorf("InputParts = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestQuoteOfFindsTheQuotePartAndIsEmptyWithoutOne(t *testing.T) {
	if got := QuoteOf(InputParts("t", "q")); got != "q" {
		t.Errorf("QuoteOf = %q, want q", got)
	}
	if got := QuoteOf(InputParts("t", "")); got != "" {
		t.Errorf("QuoteOf without a quote = %q", got)
	}
}
