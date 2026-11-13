// Package host lets core run on its own, outside the app that starts it: the
// single-instance lock on the data folder, the owner-only discovery file, the
// --detach launcher and waits on other processes by pid.
//
// It is foundation: it knows nothing about config, events or the API.
package host
