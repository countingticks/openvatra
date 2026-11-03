//go:build !windows

package process

import "os/exec"

// OpenVatra ships for Windows only. These stand-ins keep `go vet` and the tests
// working on other systems; they kill just the direct child, not its descendants.

func SetupTreeCleanup() error { return nil }

func setProcAttributes(cmd *exec.Cmd) {}

func terminateProcessTree(cmd *exec.Cmd) error { return cmd.Process.Kill() }

func killProcessTree(cmd *exec.Cmd) error { return cmd.Process.Kill() }
