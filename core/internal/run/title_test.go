package run

import (
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/store"
)

func TestCleanTitle(t *testing.T) {
	long := strings.Repeat("word ", 19) + "words" // 100 runes
	cases := []struct {
		name, in, want string
	}{
		{"plain", "Trip to Cluj", "Trip to Cluj"},
		{"quotes and a trailing period", `"Trip to Cluj."`, "Trip to Cluj"},
		{"curly quotes and emphasis", "**“Trip to Cluj”**", "Trip to Cluj"},
		{"backticks", "`Trip to Cluj`", "Trip to Cluj"},
		{"guillemets inside single quotes", "'«Voyage à Cluj»'", "Voyage à Cluj"},
		{"a Title label in any case", "TITLE: Trip to Cluj!", "Trip to Cluj"},
		{"a label then quotes", `Title: "Trip to Cluj"`, "Trip to Cluj"},
		{"first non-empty line only", "\n\n  Trip to Cluj\nA second line", "Trip to Cluj"},
		{"trailing ellipsis and colon", "Trip to Cluj…:", "Trip to Cluj"},
		{"whitespace collapsed", "Trip   to\tCluj", "Trip to Cluj"},
		{"a 100-rune title is cut", long, store.CutTitle(long)},
		{"blank", " \n\t ", ""},
		{"empty", "", ""},
		{"only quotes", `""`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cleanTitle(tc.in); got != tc.want {
				t.Fatalf("cleanTitle(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
