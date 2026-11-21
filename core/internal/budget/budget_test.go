package budget

import (
	"strings"
	"testing"
)

func TestEstimateTokens(t *testing.T) {
	t.Run("EstimateTokens rounds up", func(t *testing.T) {
		for in, want := range map[string]int{"": 0, "abcdefg": 2, "abcdefgh": 3, strings.Repeat("x", 35): 10, "ăîș": 1} {
			if got := EstimateTokens(in); got != want {
				t.Errorf("EstimateTokens(%q) = %d, want %d", in, got, want)
			}
		}
	})
}
