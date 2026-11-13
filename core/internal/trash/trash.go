// Package trash moves files and folders to the Windows Recycle Bin, so a removed model can still be restored.
package trash

import (
	"fmt"
	"path/filepath"
)

// Move sends path (a file or folder) to the Recycle Bin. path must be absolute: the shell resolves a relative one
// against its own working folder, and only a full path can be undone (FOF_ALLOWUNDO).
func Move(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("trash: %q is not an absolute path", path)
	}
	return move(filepath.Clean(path))
}
