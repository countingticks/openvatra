// Package hw measures what the PC has for running models: the GPU llama.cpp can use, total RAM and free disk.
package hw

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// listTimeout bounds `llama-server --list-devices`; a hung driver must not hang the check.
const listTimeout = 15 * time.Second

const mib = 1 << 20

// Vendors, as the UI receives them.
const (
	VendorNVIDIA = "nvidia"
	VendorAMD    = "amd"
	VendorIntel  = "intel"
	VendorOther  = "other"
)

// GPU is one device as llama.cpp reports it.
type GPU struct {
	Name       string `json:"name"`
	Vendor     string `json:"vendor"`
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
}

// Report is the JSON of GET /api/hardware. GPU is null when there is none (or the check failed); Error says why a
// part could not be measured, in words fit for the UI. The details go to the log.
type Report struct {
	GPU      *GPU   `json:"gpu"`
	RAMBytes uint64 `json:"ramBytes"`
	Error    string `json:"error,omitempty"`
}

// deviceLine matches "  Vulkan0: NVIDIA GeForce RTX 4070 SUPER (12213 MiB, 11033 MiB free)". The name is greedy
// and the memory group is anchored at the end, so names with their own brackets ("Radeon(TM)") still parse.
var deviceLine = regexp.MustCompile(`^(\S+):\s+(.*\S)\s+\((\d+) MiB, (\d+) MiB free\)$`)

// ParseDevices reads the output of `llama-server --list-devices`. Lines that are not a device (the header, driver
// logs) are skipped, so an empty result means "no GPU".
func ParseDevices(out []byte) []GPU {
	var gpus []GPU
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		m := deviceLine.FindStringSubmatch(strings.TrimSpace(sc.Text()))
		if m == nil {
			continue
		}
		total, err1 := strconv.ParseUint(m[3], 10, 64)
		free, err2 := strconv.ParseUint(m[4], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		gpus = append(gpus, GPU{Name: m[2], Vendor: vendorOf(m[2]), TotalBytes: total * mib, FreeBytes: free * mib})
	}
	return gpus
}

// vendorOf guesses the vendor from the device name; the fit rule only needs it for advice (e.g. the CUDA offer).
func vendorOf(name string) string {
	for _, word := range strings.Fields(strings.ToLower(name)) {
		switch word {
		case "nvidia", "geforce", "quadro", "tesla":
			return VendorNVIDIA
		case "amd", "radeon", "amd(r)", "radeon(tm)":
			return VendorAMD
		case "intel", "intel(r)":
			return VendorIntel
		}
	}
	return VendorOther
}

// best is the GPU with the most memory: the one a model would be put on. Ties keep llama.cpp's order.
func best(gpus []GPU) *GPU {
	var pick *GPU
	for i := range gpus {
		if pick == nil || gpus[i].TotalBytes > pick.TotalBytes {
			pick = &gpus[i]
		}
	}
	return pick
}

// Checker measures once and keeps the result until Refresh, so opening the UI never waits on llama-server again.
type Checker struct {
	serverPath func() string // read live: the engine can change while core runs
	log        *slog.Logger
	// Seams for tests.
	listDevices func(ctx context.Context, path string) ([]byte, error)
	ram         func() (uint64, error)

	mu     sync.Mutex // held while measuring, so parallel requests share one run
	cached *Report
}

// NewChecker returns a Checker that runs the llama-server at serverPath().
func NewChecker(serverPath func() string, log *slog.Logger) *Checker {
	return &Checker{serverPath: serverPath, log: log, listDevices: runListDevices, ram: totalRAM}
}

// Get returns the cached report, measuring first if there is none.
func (c *Checker) Get() Report {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cached != nil {
		return *c.cached
	}
	return c.measure()
}

// Refresh measures again, e.g. after the engine changed.
func (c *Checker) Refresh() Report {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.measure()
}

// measure runs with c.mu held.
func (c *Checker) measure() Report {
	var r Report
	var problems []string

	if ram, err := c.ram(); err != nil {
		c.log.Warn("hardware check: memory size unreadable", "err", err)
		problems = append(problems, "could not read the memory size")
	} else {
		r.RAMBytes = ram
	}

	path := c.serverPath()
	configured := path != ""
	if !configured {
		problems = append(problems, "no engine is set yet")
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), listTimeout)
		out, err := c.listDevices(ctx, path)
		cancel()
		if err != nil {
			c.log.Warn("hardware check: listing devices failed", "path", path, "err", err)
			problems = append(problems, "no GPU found: the engine could not list devices")
		} else {
			r.GPU = best(ParseDevices(out))
			if r.GPU == nil {
				c.log.Info("hardware check: no GPU reported")
			} else {
				c.log.Info("hardware check", "gpu", r.GPU.Name, "vramMiB", r.GPU.TotalBytes/mib, "ramMiB", r.RAMBytes/mib)
			}
		}
	}

	r.Error = strings.Join(problems, "; ")
	// Before main sends the config there is no engine to ask; don't keep that answer past the next request.
	if configured {
		c.cached = &r
	}
	return r
}

func runListDevices(ctx context.Context, path string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, path, "--list-devices")
	hideWindow(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("no answer within %s", listTimeout)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}
