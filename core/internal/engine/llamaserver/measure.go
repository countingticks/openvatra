package llamaserver

import (
	"bytes"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/countingticks/openvatra/core/internal/engine"
)

const mib = 1 << 20

// measurer reads llama-server's raw output for the buffer sizes it allocates (verbosity 4 prints them) and sums them
// into the memory the load used.
type measurer struct {
	mu        sync.Mutex
	partial   []byte // the unfinished last line
	vram, ram int64
	seen      bool

	// What llama.cpp's fit says about an experts load; layers is 0 for any other spec, which ignores the fit lines.
	layers      int  // the model's layers
	overflowing int  // experts layers the last fit device line sent to system memory
	gpuExperts  int  // the answer; 0 = not known
	fitFailed   bool // fit gave up: nothing it prints later counts
}

// fitDevice is fit's per-device summary; "(k overflowing)" is absent when nothing overflows.
var fitDevice = regexp.MustCompile(`common_params_fit_impl:\s+-\s+\S+ \(.*\): \d+ layers(?: \((\d+) overflowing\))?,`)

// fitLine reads the lines of llama.cpp's fit that say how many expert layers stayed on the GPU.
func (m *measurer) fitLine(s string) {
	if m.layers == 0 || m.fitFailed {
		return
	}
	switch {
	case strings.Contains(s, "common_fit_params: failed to fit params"),
		strings.Contains(s, "encountered an error while trying to fit params"):
		m.fitFailed, m.gpuExperts = true, 0
	case strings.Contains(s, "common_fit_params: successfully fit params to free device memory"):
		m.gpuExperts = min(max(m.layers-m.overflowing, 0), m.layers)
	case strings.Contains(s, "common_params_fit_impl:") && strings.Contains(s, "no changes needed"):
		m.gpuExperts = m.layers
	default:
		if g := fitDevice.FindStringSubmatch(s); g != nil {
			m.overflowing = 0
			if g[1] != "" {
				m.overflowing, _ = strconv.Atoi(g[1])
			}
		}
	}
}

// Write never fails: a line it cannot read is skipped.
func (m *measurer) Write(data []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.partial = append(m.partial, data...)
	for {
		i := bytes.IndexByte(m.partial, '\n')
		if i < 0 {
			break
		}
		m.line(string(m.partial[:i]))
		m.partial = m.partial[i+1:]
	}
	return len(data), nil
}

// line reads "<device> <kind> buffer size = <n> MiB"; each line is rounded to bytes on its own, then summed.
func (m *measurer) line(s string) {
	m.fitLine(s)
	before, after, ok := strings.Cut(s, "buffer size =")
	if !ok {
		return
	}
	words := strings.Fields(before)
	rest := strings.Fields(after)
	if len(words) < 2 || len(rest) < 2 || rest[1] != "MiB" {
		return
	}
	size, err := strconv.ParseFloat(rest[0], 64)
	if err != nil || size < 0 || math.IsInf(size, 0) || math.IsNaN(size) {
		return
	}
	bytes := int64(math.Round(size * mib))
	device := words[len(words)-2] // the word before "model", "KV", "compute"...
	if strings.HasPrefix(device, "CPU") || strings.HasSuffix(device, "_Host") {
		m.ram += bytes
	} else {
		m.vram += bytes
	}
	m.seen = true
}

func (m *measurer) measured() (engine.Resources, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.seen {
		return engine.Resources{}, false
	}
	return engine.Resources{VRAMBytes: m.vram, RAMBytes: m.ram, Known: true, Source: "measured", GPUExpertLayers: m.gpuExperts}, true
}

// measuredInstance is a running chat server that also knows what its load measured.
type measuredInstance struct {
	engine.Instance
	m *measurer
}

func (i *measuredInstance) Measured() (engine.Resources, bool) { return i.m.measured() }
