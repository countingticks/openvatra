// Adapted from llama-swap (MIT), internal/process/runtime_windows.go @ f0a34e78eac17ab699ea78e64d898f54c5bc448d

//go:build windows

package process

import (
	"fmt"
	"os/exec"
	"syscall"
)

// setProcAttributes keeps the child from opening its own console window.
func setProcAttributes(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}

// terminateProcessTree asks the process and its children to close. Windows has no
// SIGTERM or process groups, so this uses `taskkill /t` (walks the child tree by PID).
func terminateProcessTree(cmd *exec.Cmd) error {
	return taskkill(cmd, false)
}

// killProcessTree force-kills the process and every descendant (`taskkill /f /t`).
func killProcessTree(cmd *exec.Cmd) error {
	return taskkill(cmd, true)
}

func taskkill(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	args := make([]string, 0, 4)
	if force {
		args = append(args, "/f")
	}
	args = append(args, "/t", "/pid", fmt.Sprintf("%d", cmd.Process.Pid))
	kill := exec.Command("taskkill", args...)
	setProcAttributes(kill)
	return kill.Run()
}
