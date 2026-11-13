//go:build windows

package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// ErrLocked means another core holds the data folder.
var ErrLocked = errors.New("another core holds the data folder")

// FolderLock is an exclusive lock on a data folder, held while its file stays open.
// Windows releases it when the process ends, crash included.
type FolderLock struct {
	f *os.File
}

// Lock takes the single-instance lock on dataDir, creating the folder if missing.
func Lock(dataDir string) (*FolderLock, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data folder: %w", err)
	}
	f, err := os.OpenFile(filepath.Join(dataDir, "core.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	var ol windows.Overlapped
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &ol); err != nil {
		f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("lock data folder: %w", err)
	}
	return &FolderLock{f: f}, nil
}

// Close releases the lock. Closing twice is harmless.
func (l *FolderLock) Close() error {
	if l.f == nil {
		return nil
	}
	f := l.f
	l.f = nil
	var ol windows.Overlapped
	unlockErr := windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &ol)
	if err := f.Close(); err != nil {
		return fmt.Errorf("close lock file: %w", err)
	}
	if unlockErr != nil {
		return fmt.Errorf("unlock data folder: %w", unlockErr)
	}
	return nil
}
