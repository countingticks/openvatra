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

type upgradeCase struct {
	Name      string   `json:"name"`
	Text      string   `json:"text"`
	Args      string   `json:"args"`
	Context   int      `json:"context"`
	Placement string   `json:"placement"`
	Dropped   []string `json:"dropped"`
}

func TestUpgradeArgsFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/upgrade.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []upgradeCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := UpgradeArgs(c.Text)
			if err != nil {
				t.Fatal(err)
			}
			if got.Args != c.Args || got.Context != c.Context || got.Placement != c.Placement ||
				!slices.Equal(got.Dropped, c.Dropped) {
				t.Fatalf("UpgradeArgs = %+v, want %+v", got, c)
			}
		})
	}
}

func TestUpgradeArgsFailsOnlyWhenTheTextDoesNotSplit(t *testing.T) {
	if _, err := UpgradeArgs(`-c "8192`); err == nil || err.Error() != `A quote " is not closed.` {
		t.Fatalf("err = %v", err)
	}
	if _, err := UpgradeArgs("--port 1 -c 8192"); err != nil {
		t.Fatalf("a reserved flag failed the upgrade: %v", err)
	}
}

func TestJoinArgsQuotesOnlyWhatNeedsIt(t *testing.T) {
	args := []string{"-c", "4096", "--x", `D:\My Models\a.gguf`, ""}
	text := JoinArgs(args)
	if text != `-c 4096 --x "D:\My Models\a.gguf" ""` {
		t.Fatalf("JoinArgs = %q", text)
	}
	if back, err := Words(text); err != nil || !slices.Equal(back, args) {
		t.Fatalf("Words(JoinArgs) = %#v, %v", back, err)
	}
	if got := JoinArgs([]string{`say "hi"`}); got != `"say hi"` {
		t.Fatalf("JoinArgs drops quotes = %q", got)
	}
}
