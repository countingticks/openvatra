package config

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

type argsCase struct {
	Name  string   `json:"name"`
	Text  string   `json:"text"`
	Args  []string `json:"args"`
	Error string   `json:"error"`
}

func argsCases(t *testing.T) []argsCase {
	t.Helper()
	data, err := os.ReadFile("testdata/args.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []argsCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func TestSplitArgsFixture(t *testing.T) {
	for _, c := range argsCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			args, err := SplitArgs(c.Text)
			if c.Error != "" {
				if err == nil || err.Error() != c.Error {
					t.Fatalf("err = %v, want %q", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if args == nil || !slices.Equal(args, c.Args) {
				t.Fatalf("args = %#v, want %#v", args, c.Args)
			}
		})
	}
}

func TestSplitArgsLengthCountsUTF16Units(t *testing.T) {
	for _, c := range []struct {
		name string
		text string
		ok   bool
	}{
		{"2000 a", strings.Repeat("a", 2000), true},
		{"2001 a", strings.Repeat("a", 2001), false},
		{"1000 emoji", strings.Repeat("😀", 1000), true},
		{"1001 emoji", strings.Repeat("😀", 1001), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := SplitArgs(c.text)
			if (err == nil) != c.ok {
				t.Fatalf("err = %v, want ok=%v", err, c.ok)
			}
			if err != nil && err.Error() != "At most 2000 characters." {
				t.Fatalf("err = %v", err)
			}
		})
	}
}
