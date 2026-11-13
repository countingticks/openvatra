//go:build !windows

package trash

import "errors"

func move(string) error { return errors.ErrUnsupported }
