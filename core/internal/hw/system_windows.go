//go:build windows

package hw

import (
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// x/sys/windows has no wrapper for GlobalMemoryStatusEx, so it is called through its lazy DLL loader, which only
// loads kernel32 from the system folder (never from the working directory).
var procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

// memoryStatusEx mirrors MEMORYSTATUSEX; Windows reads Length to know which version of the struct it was given.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// totalRAM is the installed memory Windows can use.
func totalRAM() (uint64, error) {
	ms := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if ok, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms))); ok == 0 {
		return 0, err
	}
	return ms.TotalPhys, nil
}

// DiskFree is the space the current user may still write on the drive that holds dir (quotas included).
func DiskFree(dir string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, nil, nil); err != nil {
		return 0, err
	}
	return free, nil
}

// hideWindow keeps llama-server from flashing a console window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
