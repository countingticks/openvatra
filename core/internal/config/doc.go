// Package config holds core's settings. Core owns them: each section is a typed Go value with defaults and a
// Validate method, cached in memory and saved in openvatra.db's config table with a revision, so two writers can't
// silently overwrite each other. Readers get the cached value and never wait for the disk.
package config
