package event

import (
	"fmt"
	"regexp"
	"strings"
)

const maxFilterStreams = 32

// Filter selects streams by exact name or by kind ("run:*"). An empty filter matches everything.
type Filter struct{ Streams []string }

var kindWildcard = regexp.MustCompile(`^[a-z]+:\*$`)

// ParseFilter parses a comma-separated list such as "chat:ab12,system" or "run:*".
func ParseFilter(s string) (Filter, error) {
	if s == "" {
		return Filter{}, nil
	}
	items := strings.Split(s, ",")
	if len(items) > maxFilterStreams {
		return Filter{}, fmt.Errorf("at most %d streams, got %d", maxFilterStreams, len(items))
	}
	for _, item := range items {
		if !ValidStream(item) && !kindWildcard.MatchString(item) {
			return Filter{}, fmt.Errorf("invalid stream %q", item)
		}
	}
	return Filter{Streams: items}, nil
}

// Match reports whether stream passes the filter.
func (f Filter) Match(stream string) bool {
	if len(f.Streams) == 0 {
		return true
	}
	for _, item := range f.Streams {
		if kind, ok := strings.CutSuffix(item, ":*"); ok {
			if strings.HasPrefix(stream, kind+":") {
				return true
			}
		} else if item == stream {
			return true
		}
	}
	return false
}
