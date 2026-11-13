package downloads

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// BundledEngine is the llama.cpp build that ships with the app.
type BundledEngine struct {
	Tag *string `json:"tag" doc:"release tag of the llama.cpp build shipped with the app; null when unreadable"`
}

// EnginesBody is the JSON of GET /api/engines.
type EnginesBody struct {
	Bundled BundledEngine `json:"bundled"`
	Cuda    string        `json:"cuda" enum:"none,ready,stale" doc:"ready: installed for the pinned tag; stale: only an older one"`
}

// CUDA engine states.
const (
	cudaNone  = "none"
	cudaReady = "ready"
	cudaStale = "stale"
)

// PinnedTag is llama.json's "tag"; "" when the file or field is unreadable. The bundled build and the CUDA download
// both belong to it.
func PinnedTag(manifestPath string) string {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return ""
	}
	var m struct {
		Tag string `json:"tag"`
	}
	if json.Unmarshal(data, &m) != nil {
		return ""
	}
	return m.Tag
}

// Engines reads the disk on every call: a CUDA download can finish and an app update can move the pinned tag.
func Engines(llamaDir, enginesDir, pinnedTag string) EnginesBody {
	return EnginesBody{Bundled: BundledEngine{Tag: bundledTag(llamaDir)}, Cuda: cudaStatus(enginesDir, pinnedTag)}
}

// bundledTag is the release tag the fetch script wrote beside the exe, or nil.
func bundledTag(llamaDir string) *string {
	if llamaDir == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(llamaDir, ".tag"))
	if err != nil {
		return nil
	}
	tag := strings.TrimSpace(string(data))
	if tag == "" {
		return nil
	}
	return &tag
}

// cudaStatus looks in the engines folder, where a CUDA download lands as <tag>-cuda once it is complete. An app update
// moves the pinned tag, so an older folder is "stale": still on disk, but not what core would run.
func cudaStatus(enginesDir, pinnedTag string) string {
	if enginesDir == "" {
		return cudaNone
	}
	pinned := ""
	if pinnedTag != "" {
		pinned = pinnedTag + "-cuda"
		if hasServer(filepath.Join(enginesDir, pinned)) {
			return cudaReady
		}
	}
	entries, err := os.ReadDir(enginesDir)
	if err != nil {
		return cudaNone
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasSuffix(e.Name(), "-cuda") && e.Name() != pinned &&
			hasServer(filepath.Join(enginesDir, e.Name())) {
			return cudaStale
		}
	}
	return cudaNone
}

func hasServer(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "llama-server.exe"))
	return err == nil
}
