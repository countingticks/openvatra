package llamaserver

import (
	"bytes"
	"math"
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
	return engine.Resources{VRAMBytes: m.vram, RAMBytes: m.ram, Known: true, Source: "measured"}, true
}

// measuredInstance is a running chat server that also knows what its load measured.
type measuredInstance struct {
	engine.Instance
	m *measurer
}

func (i *measuredInstance) Measured() (engine.Resources, bool) { return i.m.measured() }
