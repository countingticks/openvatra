// Package clash holds a type whose name collides with one in the openapi tests.
package clash

// Item shares its name with a type declared in the openapi tests.
type Item struct{ A string }
