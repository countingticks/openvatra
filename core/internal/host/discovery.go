package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DiscoveryFile is how the shell and the CLI find a running core in its data folder.
const DiscoveryFile = "core.json"

// ErrNoDiscovery means no core has written its discovery file (or it removed it on exit).
var ErrNoDiscovery = errors.New("no core.json in the data folder")

// Discovery is the content of core.json. Exe and Args are the fingerprint the
// shell compares to decide whether a running core is the one it would start.
type Discovery struct {
	PID       int       `json:"pid"`
	Port      int       `json:"port"`
	Token     string    `json:"token"`
	Version   string    `json:"version"`
	API       int       `json:"api"`
	Exe       string    `json:"exe"`
	Args      []string  `json:"args"`
	StartedAt time.Time `json:"startedAt"`
}

// ReadDiscovery reads core.json from dataDir. Errors never quote the file's
// content, which holds the token.
func ReadDiscovery(dataDir string) (Discovery, error) {
	var d Discovery
	data, err := os.ReadFile(filepath.Join(dataDir, DiscoveryFile))
	if errors.Is(err, os.ErrNotExist) {
		return d, ErrNoDiscovery
	}
	if err != nil {
		return d, fmt.Errorf("read %s: %w", DiscoveryFile, err)
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return Discovery{}, fmt.Errorf("parse %s: %w", DiscoveryFile, err)
	}
	return d, nil
}

// RemoveDiscovery deletes core.json only when it belongs to pid, so a core never
// removes the file of a newer core that took over the data folder.
func RemoveDiscovery(dataDir string, pid int) error {
	d, err := ReadDiscovery(dataDir)
	if err != nil || d.PID != pid {
		return nil
	}
	if err := os.Remove(filepath.Join(dataDir, DiscoveryFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", DiscoveryFile, err)
	}
	return nil
}

func marshalDiscovery(d Discovery) ([]byte, error) {
	if d.Args == nil {
		d.Args = []string{}
	}
	data, err := json.Marshal(d)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", DiscoveryFile, err)
	}
	return append(data, '\n'), nil
}
