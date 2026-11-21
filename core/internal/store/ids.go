package store

import (
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// ErrNotFound is returned when a chat, run or message id doesn't exist.
var ErrNotFound = errors.New("not found")

// titleLength is how long the title cut from the first message may be, in characters.
const titleLength = 50

// NewID returns a random UUID v4. Random ids reveal nothing about how many chats exist (unlike 1, 2, 3...).
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failing means the OS is broken; nothing sensible to do
	}
	b[6] = b[6]&0x0f | 0x40 // version 4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// CutTitle makes a temporary title from the first message: whitespace collapsed, cut at a word boundary to about
// titleLength characters, with an ellipsis when something was cut.
func CutTitle(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= titleLength {
		return text
	}
	cut := string([]rune(text)[:titleLength])
	// Prefer the last space, unless that would throw away most of the title (one very long word).
	if i := strings.LastIndex(cut, " "); i >= titleLength/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " .,;:!?-") + "…"
}
