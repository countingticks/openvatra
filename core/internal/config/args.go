package config

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

// MaxArgsLength is the longest argument text, in UTF-16 code units (what JavaScript's .length counts).
const MaxArgsLength = 2000

// ReservedFlags are set by core itself; the same list, in the same order, as src/shared/args.ts.
var ReservedFlags = []string{"-m", "--model", "--host", "--port", "--embedding", "--embeddings", "-mm", "--mmproj"}

// isJSSpace is JavaScript's \s, not unicode.IsSpace: the two differ at U+0085 and U+FEFF, and the UI and core must
// split the same text the same way.
func isJSSpace(r rune) bool {
	switch {
	case r >= '\t' && r <= '\r', r == ' ', r == 0xA0, r == 0x1680, r >= 0x2000 && r <= 0x200A:
		return true
	}
	switch r {
	case 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return false
}

// SplitArgs is the Go twin of splitArgs in src/shared/args.ts (see there for the syntax); the error texts match.
func SplitArgs(text string) ([]string, error) {
	args, err := Words(text)
	if err != nil {
		return nil, err
	}
	for _, arg := range args {
		name, _, _ := strings.Cut(arg, "=")
		if slices.Contains(ReservedFlags, name) {
			return nil, fmt.Errorf("%s is set by OpenVatra and can't be changed.", name)
		}
	}
	return args, nil
}

// Words splits like SplitArgs without the reserved check (same error texts for length and quotes).
func Words(text string) ([]string, error) {
	units := 0
	for _, r := range text {
		units += utf16.RuneLen(r)
	}
	if units > MaxArgsLength {
		return nil, fmt.Errorf("At most %d characters.", MaxArgsLength)
	}

	args := []string{}
	var current strings.Builder
	inArg, quoted := false, false // inArg tells "" (an empty argument) apart from nothing at all
	for _, r := range text {
		switch {
		case r == '"':
			quoted = !quoted
			inArg = true
		case !quoted && isJSSpace(r):
			if inArg {
				args = append(args, current.String())
			}
			current.Reset()
			inArg = false
		default:
			current.WriteRune(r)
			inArg = true
		}
	}
	if quoted {
		return nil, errors.New(`A quote " is not closed.`)
	}
	if inArg {
		args = append(args, current.String())
	}
	return args, nil
}

// JoinArgs is the Go twin of joinArgs in src/shared/args.ts: it quotes only what needs it, and drops any " (the
// syntax can't write one inside an argument).
func JoinArgs(args []string) string {
	out := make([]string, len(args))
	for i, arg := range args {
		arg = strings.ReplaceAll(arg, `"`, "")
		if arg == "" || strings.IndexFunc(arg, isJSSpace) >= 0 {
			arg = `"` + arg + `"`
		}
		out[i] = arg
	}
	return strings.Join(out, " ")
}

// ValidatePath accepts nil (not chosen) or a non-empty absolute path without a NUL; the message names field.
func ValidatePath(field string, p *string) error {
	if p != nil && (*p == "" || !filepath.IsAbs(*p) || strings.ContainsRune(*p, 0)) {
		return fmt.Errorf("%s must be an absolute path", field)
	}
	return nil
}

// The context sizes a size flag may carry to become a context field (llamacpp.MinContext and MaxContext; config
// cannot import its owner).
const (
	upgradeMinContext = 2048
	upgradeMaxContext = 1048576
)

// Upgraded is an argument text with its size and placement flags taken out (UpgradeArgs).
type Upgraded struct {
	Args      string   // the text left, rejoined with JoinArgs; "" when nothing is left
	Context   int      // 0 = no size flag
	Placement string   // "", "gpu", "experts" or "layers"
	Dropped   []string // flags removed without a field, in order (e.g. "--n-cpu-moe 4", "-c abc")
}

// UpgradeArgs takes the flags that became core's own (-c, -ngl, --cpu-moe, --n-cpu-moe, --fit and their aliases) out
// of an argument text stored before they were reserved, turning each into the context or placement field it means.
// It is the Go twin of upgradeArgs in src/shared/args.ts; both read testdata/upgrade.json. Text without such a flag
// comes back as it was. The error is Words' only.
func UpgradeArgs(text string) (Upgraded, error) {
	words, err := Words(text)
	if err != nil {
		return Upgraded{}, err
	}
	var up Upgraded
	kept := []string{}
	experts, layers, taken := false, "", false
	for i := 0; i < len(words); i++ {
		name, inline, hasInline := strings.Cut(words[i], "=")
		// value is the flag's value: after = in the same word, else the next word (taken from the text).
		value := func() (string, string, bool) {
			if hasInline {
				return inline, words[i], true
			}
			if i+1 < len(words) {
				i++
				return words[i], words[i-1] + " " + words[i], true
			}
			return "", words[i], false
		}
		switch name {
		case "-c", "--ctx-size":
			taken = true
			v, flag, ok := value()
			if n, isInt := upgradeInt(v); ok && isInt && n >= upgradeMinContext && n <= upgradeMaxContext {
				up.Context = n
			} else {
				up.Dropped = append(up.Dropped, flag)
			}
		case "-cmoe", "--cpu-moe":
			taken, experts = true, true
		case "-ngl", "--gpu-layers", "--n-gpu-layers":
			taken = true
			v, flag, ok := value()
			n, isInt := upgradeInt(v)
			switch {
			case !ok:
				up.Dropped = append(up.Dropped, flag)
			case v == "all" || isInt && n >= 99:
				layers = "gpu"
			case v == "auto":
				layers = ""
			case isInt:
				layers = "layers" // core picks the number itself
			default:
				up.Dropped = append(up.Dropped, flag)
			}
		case "-ncmoe", "--n-cpu-moe":
			taken = true
			_, flag, _ := value()
			up.Dropped = append(up.Dropped, flag)
		case "-fit", "--fit":
			taken = true
			flag := words[i]
			if !hasInline && i+1 < len(words) && (words[i+1] == "on" || words[i+1] == "off") {
				i++
				flag += " " + words[i]
			}
			up.Dropped = append(up.Dropped, flag)
		default:
			kept = append(kept, words[i])
		}
	}
	if !taken {
		return Upgraded{Args: text}, nil
	}
	up.Args = JoinArgs(kept)
	up.Placement = layers
	if experts {
		up.Placement = "experts"
	}
	return up, nil
}

// upgradeInt reads ASCII digits only (no sign), as upgradeArgs in TypeScript does; a number too large for int reads
// as the largest int.
func upgradeInt(s string) (int, bool) {
	if s == "" || strings.Trim(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return math.MaxInt, true
	}
	return n, true
}
