package llamaserver

import (
	"path/filepath"
	"runtime"
	"strings"
)

// longPathFrom is the length from which a path gets the \\?\ prefix. llama-server is not long-path aware, so it
// cannot open a path over MAX_PATH (260) without it; Go's os package uses the same 248 (the directory limit).
// The length is in bytes, which is never less than Windows' UTF-16 count.
const longPathFrom = 248

// longPath gives a long absolute Windows path the \\?\ prefix, so llama-server can open it; any other path is
// returned unchanged, as it reads better in the log. The prefix turns off Windows' own path parsing, so the path is
// cleaned first.
func longPath(p string) string {
	if runtime.GOOS != "windows" || len(p) < longPathFrom || !filepath.IsAbs(p) || strings.HasPrefix(p, `\\?\`) {
		return p
	}
	p = filepath.Clean(p)
	if rest, ok := strings.CutPrefix(p, `\\`); ok {
		return `\\?\UNC\` + rest
	}
	return `\\?\` + p
}
