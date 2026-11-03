// Adapted from llama-swap (MIT), internal/process/treecleanup_windows.go @ f0a34e78eac17ab699ea78e64d898f54c5bc448d

//go:build windows

package process

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SetupTreeCleanup puts the current process in a Windows Job Object set to kill
// everything in it when the job closes. Child processes started afterwards join
// the same job, so if core dies for any reason (even a crash), Windows kills every
// llama-server instead of leaving it running with the model in memory.
//
// The handle is deliberately never closed: the kill fires when the last handle goes
// away, which is when this process exits.
func SetupTreeCleanup() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("CreateJobObject: %w", err)
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("SetInformationJobObject: %w", err)
	}

	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("AssignProcessToJobObject: %w", err)
	}

	return nil
}
