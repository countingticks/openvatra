package config

import (
	"errors"
	"fmt"
	"slices"
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

	for _, arg := range args {
		name, _, _ := strings.Cut(arg, "=")
		if slices.Contains(ReservedFlags, name) {
			return nil, fmt.Errorf("%s is set by OpenVatra and can't be changed.", name)
		}
	}
	return args, nil
}
