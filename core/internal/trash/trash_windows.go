package trash

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

var procSHFileOperationW = syscall.NewLazyDLL("shell32.dll").NewProc("SHFileOperationW")

const (
	foDelete = 3

	fofSilent         = 0x4
	fofNoConfirmation = 0x10
	fofAllowUndo      = 0x40
	fofNoErrorUI      = 0x400
)

// shFileOpStruct is SHFILEOPSTRUCTW. shellapi.h packs it to 1 byte only on 32-bit Windows; on amd64 it has natural
// alignment, which is Go's own layout for these fields.
type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

func move(path string) error {
	from, err := syscall.UTF16FromString(path)
	if err != nil {
		return fmt.Errorf("trash: %w", err)
	}
	// pFrom is a list of paths, each ending in a NUL, the list ending in a second one.
	from = append(from, 0)
	op := shFileOpStruct{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
	}
	// The shell's file operations use COM, which is bound to the calling OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	runtime.KeepAlive(from)
	if r != 0 {
		return fmt.Errorf("trash: SHFileOperationW failed: %#x", uint32(r))
	}
	if op.fAnyOperationsAborted != 0 {
		return errors.New("trash: the move to the Recycle Bin was cancelled")
	}
	return nil
}
