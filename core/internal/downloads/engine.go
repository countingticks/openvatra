package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/download"
)

// EngineID is the engine's id in the queue and in /api/downloads/{id}.
const EngineID = "engine-cuda"

// Engine is the CUDA build of llama.cpp: two zips from the same release as the bundled build, unpacked together into
// <Dir>\<tag>-cuda. Main resolves "does that folder exist for the current tag" itself; core only puts it there.
type Engine struct {
	Tag   string
	Files []catalog.File // the engine zip, then the CUDA runtime zip
	Dir   string         // the engines folder
	// Extract unpacks one zip into dest. nil means Windows' own tar.exe; tests replace it.
	Extract func(ctx context.Context, zip, dest string) error

	// Test seams: a local server instead of GitHub (and the host list that lets it through).
	baseURL   string
	allowHost func(string) bool
}

// finalDir is where the finished engine lives. Its existence is the "installed" marker, so it only appears once the
// unpacked folder is complete (see finish).
func (e *Engine) finalDir() string { return filepath.Join(e.Dir, e.Tag+"-cuda") }

// serverExe is what a usable engine folder must contain.
func (e *Engine) serverExe() string { return filepath.Join(e.finalDir(), "llama-server.exe") }

// The names come from llama.json, which ships with the app, but they end up in URLs and paths: allow plain file names
// only, so a bad manifest can't reach outside the engines folder.
var (
	tagPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	assetPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$`)
	shaPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type manifestAsset struct {
	Asset  string `json:"asset"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// LoadEngine reads the CUDA pin from resources/llama/llama.json. (nil, nil) means the manifest has no cuda section.
func LoadEngine(manifestPath, enginesDir string) (*Engine, error) {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	var m struct {
		Tag  string `json:"tag"`
		Cuda *struct {
			manifestAsset
			Runtime manifestAsset `json:"runtime"`
		} `json:"cuda"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("llama manifest: %w", err)
	}
	if m.Cuda == nil {
		return nil, nil
	}
	if !tagPattern.MatchString(m.Tag) {
		return nil, errors.New("llama manifest: bad tag")
	}
	e := &Engine{Tag: m.Tag, Dir: enginesDir}
	for _, a := range []manifestAsset{m.Cuda.manifestAsset, m.Cuda.Runtime} {
		if !assetPattern.MatchString(a.Asset) || !shaPattern.MatchString(a.SHA256) || a.Size <= 0 {
			return nil, fmt.Errorf("llama manifest: bad cuda asset %q", a.Asset)
		}
		e.Files = append(e.Files, catalog.File{Name: a.Asset, SizeBytes: a.Size, SHA256: a.SHA256})
	}
	return e, nil
}

func (e *Engine) target() target {
	base, allow := "https://github.com/ggml-org/llama.cpp/releases/download", e.allowHost
	if e.baseURL != "" {
		base = e.baseURL
	}
	if allow == nil {
		allow = download.GitHubReleaseHost
	}
	return target{
		id:    EngineID,
		files: e.Files,
		// The zips wait here; the folder users and main look at is finalDir, which never holds half an engine.
		folder: filepath.Join(e.Dir, e.Tag+"-cuda.download"),
		url: func(f catalog.File) string {
			return fmt.Sprintf("%s/%s/%s", base, e.Tag, f.Name)
		},
		allowHost: allow,
		installed: func() bool { info, err := os.Stat(e.serverExe()); return err == nil && info.Mode().IsRegular() },
		extra:     totalSize(e.Files), // unpacked, the DLLs take about as much as the zips
		finish:    e.finish,
	}
}

// finish unpacks both zips beside the final folder and renames it into place, so a crash or a failed unpack never
// leaves a folder that looks installed. The zips are deleted last; until then a retry only repeats the unpacking.
func (e *Engine) finish(ctx context.Context, downloadDir string) error {
	extract := e.Extract
	if extract == nil {
		extract = tarExtract
	}
	tmp := e.finalDir() + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	for _, f := range e.Files {
		if err := extract(ctx, filepath.Join(downloadDir, f.Name), tmp); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
	}
	if info, err := os.Stat(filepath.Join(tmp, "llama-server.exe")); err != nil || !info.Mode().IsRegular() {
		_ = os.RemoveAll(tmp)
		return errors.New("llama-server.exe is missing from the engine zips")
	}
	if err := os.RemoveAll(e.finalDir()); err != nil { // a leftover without llama-server.exe
		return err
	}
	if err := os.Rename(tmp, e.finalDir()); err != nil {
		return err
	}
	discard(downloadDir, e.Files)
	return nil
}

// tarExtract unpacks a zip with the tar.exe that ships with Windows, as scripts/fetch-llama.mjs does. It is the full
// System32 path because Git for Windows puts a GNU tar first on PATH, and that one can't read zips. bsdtar refuses
// entries that climb out of the destination ("..") unless told otherwise with -P, which we never pass.
func tarExtract(ctx context.Context, zip, dest string) error {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	out, err := exec.CommandContext(ctx, filepath.Join(root, "System32", "tar.exe"), "-xf", zip, "-C", dest).CombinedOutput()
	if err != nil {
		return fmt.Errorf("unpacking %s: %w: %s", filepath.Base(zip), err, strings.TrimSpace(string(out)))
	}
	return nil
}
