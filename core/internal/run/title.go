package run

import (
	"strings"
	"time"
	"unicode/utf8"

	"github.com/countingticks/openvatra/core/internal/store"
)

const (
	titlePrompt = "Write a title of 3 to 6 words for a conversation that starts with the user's message below. Use the " +
		"language of the message. Reply with the title only."
	titleMaxOut      = 24
	titleInputRunes  = 2000 // of the first message: enough to say what the chat is about
	titleMaxRunes    = 60   // a longer answer is cut like a first message
	titleQuotes      = "\"'`*“”‘’«»"
	titleTrailing    = ".,!?:;…"
	titleLabelPrefix = "title:"
)

// titleTimeout bounds the title call; a var so tests can shorten it.
var titleTimeout = 15 * time.Second

// cleanTitle turns a model's answer into a chat title: its first non-empty line, without a "Title:" label,
// surrounding quotes or emphasis and trailing punctuation, whitespace collapsed and cut when long. "" when nothing
// is left.
func cleanTitle(s string) string {
	line := ""
	for l := range strings.Lines(s) {
		if l = strings.TrimSpace(l); l != "" {
			line = l
			break
		}
	}
	if len(line) >= len(titleLabelPrefix) && strings.EqualFold(line[:len(titleLabelPrefix)], titleLabelPrefix) {
		line = line[len(titleLabelPrefix):]
	}
	for {
		next := strings.TrimSpace(line)
		next = strings.Trim(next, titleQuotes)
		next = strings.TrimRight(next, titleTrailing)
		if next == line {
			break
		}
		line = next
	}
	line = strings.Join(strings.Fields(line), " ")
	if utf8.RuneCountInString(line) > titleMaxRunes {
		return store.CutTitle(line)
	}
	return line
}

// firstRunes is s cut to n runes.
func firstRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
