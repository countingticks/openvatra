package llamaserver

import (
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/engine"
)

func TestLongPath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the \\\\?\\ prefix is Windows-only")
	}
	long := strings.Repeat("d", 250)
	cases := map[string]struct{ in, want string }{
		"short absolute":   {`C:\Models\m.gguf`, `C:\Models\m.gguf`},
		"long absolute":    {`C:\Models\` + long + `\m.gguf`, `\\?\C:\Models\` + long + `\m.gguf`},
		"long, cleaned":    {`C:/Models/x/../` + long + `/m.gguf`, `\\?\C:\Models\` + long + `\m.gguf`},
		"long UNC":         {`\\nas\share\` + long + `\m.gguf`, `\\?\UNC\nas\share\` + long + `\m.gguf`},
		"already prefixed": {`\\?\C:\` + long, `\\?\C:\` + long},
		"long relative":    {long + `\m.gguf`, long + `\m.gguf`},
		"empty":            {"", ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := longPath(tc.in); got != tc.want {
				t.Fatalf("longPath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestCommandPrefixesLongModelAndProjector(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the \\\\?\\ prefix is Windows-only")
	}
	dir := `C:\Models\` + strings.Repeat("d", 250) + `\`
	args := New(fakePath, nil).Command(engine.Spec{Path: dir + "m.gguf", Projector: dir + "mmproj.gguf"}).Args
	for flag, want := range map[string]string{"-m": `\\?\` + dir + "m.gguf", "--mmproj": `\\?\` + dir + "mmproj.gguf"} {
		i := slices.Index(args, flag)
		if i < 0 || i+1 >= len(args) || args[i+1] != want {
			t.Fatalf("%s value in %q, want %q", flag, args, want)
		}
	}
}
