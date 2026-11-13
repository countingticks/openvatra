//go:build !windows

package host

import "errors"

// OpenVatra ships for Windows only. These stand-ins keep `go vet` and the tests
// working on other systems.

var ErrLocked = errors.New("another core holds the data folder")

type FolderLock struct{}

func Lock(dataDir string) (*FolderLock, error) { return nil, errors.ErrUnsupported }

func (l *FolderLock) Close() error { return nil }

func WriteDiscovery(dataDir string, d Discovery) error { return errors.ErrUnsupported }
