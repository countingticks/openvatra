//go:build !windows

package hw

import (
	"errors"
	"os/exec"
)

// OpenVatra ships for Windows only. These stand-ins keep `go vet` and the tests working on other systems.

var errUnsupported = errors.New("only measured on Windows")

func totalRAM() (uint64, error) { return 0, errUnsupported }

// DiskFree is the space the current user may still write on the drive that holds dir.
func DiskFree(dir string) (uint64, error) { return 0, errUnsupported }

func hideWindow(cmd *exec.Cmd) {}
