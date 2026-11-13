//go:build windows

package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// WriteDiscovery atomically replaces core.json in dataDir with d. The file is
// readable by the current user only: it holds the shell token.
func WriteDiscovery(dataDir string, d Discovery) error {
	data, err := marshalDiscovery(d)
	if err != nil {
		return err
	}
	path := filepath.Join(dataDir, DiscoveryFile)
	tmp := path + ".tmp"
	if err := writeOwnerOnly(tmp, data); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := replaceFile(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("replace %s: %w", DiscoveryFile, err)
	}
	return nil
}

func replaceFile(from, to string) error {
	f, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	t, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(f, t, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

func writeOwnerOnly(path string, data []byte) error {
	name := filepath.Base(path)
	sd, err := ownerOnlyDescriptor()
	if err != nil {
		return err
	}
	// CREATE_ALWAYS ignores the descriptor when the file exists, so a temp file
	// left by a crash must go first.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove old %s: %w", name, err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, &sa, windows.CREATE_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	var n uint32
	if err := windows.WriteFile(h, data, &n, nil); err != nil || int(n) != len(data) {
		windows.CloseHandle(h)
		if err == nil {
			err = errors.New("short write")
		}
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := windows.FlushFileBuffers(h); err != nil {
		windows.CloseHandle(h)
		return fmt.Errorf("flush %s: %w", name, err)
	}
	if err := windows.CloseHandle(h); err != nil {
		return fmt.Errorf("close %s: %w", name, err)
	}
	return nil
}

// ownerOnlyDescriptor is a protected DACL with full access for the current user
// and nothing inherited from the folder.
func ownerOnlyDescriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("current user: %w", err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return nil, fmt.Errorf("security descriptor: %w", err)
	}
	return sd, nil
}
