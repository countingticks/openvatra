// Package profile holds the kinds of agent a run can be: a system prompt, the tools offered and the run's limits.
// The built-ins are Go literals until profiles become files (Step 6); callers only see Registry.Get.
package profile

import (
	"strings"
	"time"
)

// Profile describes one kind of run.
type Profile struct {
	Name       string
	System     string   // may contain {{date}}
	Tools      []string // empty for chat
	Steps      int      // model calls per input
	MinContext int
	Title      bool // used from slice 4
}

// SystemPrompt is System with {{date}} filled in. The date lets a model answer "what day is it" and judge web results.
func (p Profile) SystemPrompt(now time.Time) string {
	return strings.ReplaceAll(p.System, "{{date}}", now.Format("Monday, 2 January 2006"))
}

// Registry is the set of profiles a run may name.
type Registry struct {
	byName map[string]Profile
}

// Builtin returns the profiles that ship with core.
func Builtin() *Registry {
	return &Registry{byName: map[string]Profile{
		"chat": {
			Name:   "chat",
			System: "You are a helpful assistant running on the user's own computer. Today is {{date}}.",
			Steps:  1,
			Title:  true,
		},
	}}
}

// Get returns the profile called name.
func (r *Registry) Get(name string) (Profile, bool) {
	p, ok := r.byName[name]
	return p, ok
}
