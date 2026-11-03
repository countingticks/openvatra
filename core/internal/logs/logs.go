// Package logs gives core one log file, core.log, for bug reports. It holds the
// size-based rotation and the per-model line prefix; the idea follows llama-swap's
// logmon, cut down to what core needs (no in-memory history, no streaming).
package logs

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

const (
	// FileName is the live log; older ones are core.1.log and core.2.log.
	FileName = "core.log"
	// MaxSize is how big core.log may get before it is rotated.
	MaxSize = 5 << 20
	// Files is how many log files are kept in total, live one included.
	Files = 3
)

// Rotator is a file writer that rotates by size: core.log becomes core.1.log,
// core.1.log becomes core.2.log, and the oldest is deleted. Safe for concurrent use,
// because slog and every llama-server's output writer share it.
type Rotator struct {
	dir     string
	maxSize int64

	mu   sync.Mutex
	file *os.File
	size int64
}

// NewRotator opens (creating the folder and file if needed) dir/core.log for appending.
func NewRotator(dir string, maxSize int64) (*Rotator, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	r := &Rotator{dir: dir, maxSize: maxSize}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Rotator) open() error {
	f, err := os.OpenFile(filepath.Join(r.dir, FileName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	r.file, r.size = f, info.Size()
	return nil
}

func (r *Rotator) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Rotate before writing, so one write is never split across two files.
	if r.size > 0 && r.size+int64(len(p)) > r.maxSize {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := r.file.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *Rotator) rotate() error {
	if err := r.file.Close(); err != nil {
		return err
	}
	// Shift from the oldest down; renaming over an existing file replaces it on Windows too (Go uses MoveFileEx).
	for i := Files - 1; i >= 1; i-- {
		from := filepath.Join(r.dir, FileName)
		if i > 1 {
			from = r.numbered(i - 1)
		}
		if err := os.Rename(from, r.numbered(i)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return r.open()
}

func (r *Rotator) numbered(i int) string {
	return filepath.Join(r.dir, fmt.Sprintf("core.%d.log", i))
}

func (r *Rotator) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.file.Close()
}

// Prefixed returns a writer that puts "[prefix] " in front of every line written
// to w. llama-server writes in arbitrary chunks, so partial lines are held back
// until their newline arrives. Writes are serialized, as stdout and stderr share it.
func Prefixed(w io.Writer, prefix string) io.Writer {
	return &prefixWriter{w: w, prefix: []byte("[" + prefix + "] ")}
}

type prefixWriter struct {
	w      io.Writer
	prefix []byte

	mu  sync.Mutex
	buf []byte // the unfinished last line
}

func (p *prefixWriter) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.buf = append(p.buf, data...)
	var out []byte
	for {
		i := bytes.IndexByte(p.buf, '\n')
		if i < 0 {
			break
		}
		out = append(out, p.prefix...)
		out = append(out, p.buf[:i+1]...)
		p.buf = p.buf[i+1:]
	}
	if len(out) > 0 {
		if _, err := p.w.Write(out); err != nil {
			return 0, err
		}
	}
	return len(data), nil
}

// Setup opens dir/core.log and returns a slog logger writing to it plus the raw
// writer (for llama-server output). With an empty dir it logs to discard, so
// running core by hand without a log folder still works.
func Setup(dir string) (*slog.Logger, io.Writer, io.Closer, error) {
	if dir == "" {
		return slog.New(slog.NewTextHandler(io.Discard, nil)), io.Discard, io.NopCloser(nil), nil
	}
	r, err := NewRotator(dir, MaxSize)
	if err != nil {
		return nil, nil, nil, err
	}
	return slog.New(slog.NewTextHandler(r, nil)), r, r, nil
}
