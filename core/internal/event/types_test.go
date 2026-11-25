package event

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestInputParts(t *testing.T) {
	tests := []struct {
		name   string
		text   string
		quotes []Quote
		want   []MessagePart
	}{
		{"with a quote", "t", []Quote{{Text: "q"}}, []MessagePart{{Kind: "quote", Text: "q"}, {Kind: "text", Text: "t"}}},
		{"InputParts puts every quote first, in order", "t", []Quote{{Text: "q1"}, {Text: "q2"}},
			[]MessagePart{{Kind: "quote", Text: "q1"}, {Kind: "quote", Text: "q2"}, {Kind: "text", Text: "t"}}},
		{"InputParts puts the reply on its quote part, and leaves a blank text out", " ", []Quote{{Text: "q", Reply: "why?"}},
			[]MessagePart{{Kind: "quote", Text: "q", Reply: "why?"}}},
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
	t.Run("QuotesOf lists the quote parts in order, with their replies", func(t *testing.T) {
		want := []Quote{{Text: "q1", Reply: "r1"}, {Text: "q2"}}
		if got := QuotesOf(InputParts("t", want)); !slices.Equal(got, want) {
			t.Errorf("QuotesOf = %v, want %v", got, want)
		}
	})
	t.Run("nil without a quote", func(t *testing.T) {
		if got := QuotesOf(InputParts("t", nil)); got != nil {
			t.Errorf("QuotesOf without a quote = %q", got)
		}
	})
}

func TestQuoteDecodes(t *testing.T) {
	t.Run("a Quote decodes from a bare string, and from an object with a reply", func(t *testing.T) {
		var got []Quote
		if err := json.Unmarshal([]byte(`["old",{"text":"new","reply":"why?"},{"text":"plain"}]`), &got); err != nil {
			t.Fatal(err)
		}
		if want := []Quote{{Text: "old"}, {Text: "new", Reply: "why?"}, {Text: "plain"}}; !slices.Equal(got, want) {
			t.Errorf("decoded %v, want %v", got, want)
		}
	})
	t.Run("a quote of another JSON type is an error", func(t *testing.T) {
		var got Quote
		if err := json.Unmarshal([]byte(`5`), &got); err == nil {
			t.Errorf("decoded %v from a number", got)
		}
	})
}
