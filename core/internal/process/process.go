// Package process runs one llama-server: start it, wait until it answers its
// health check, stop it. The shape follows llama-swap's internal/process, cut down
// to what core needs (no TTL, no config parsing, no proxying; the router adds those).
package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"sync"
	"time"
)

// State is where a Process is in its life.
type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateReady    State = "ready"
)

const (
	healthPath         = "/health"
	healthPollInterval = 250 * time.Millisecond
	// waitDelay bounds how long Wait lingers for output pipes after the process exits.
	// Without it a grandchild holding stdout open would make Stop hang forever.
	waitDelay = 2 * time.Second
)

// Config describes one server. Args are passed straight to the program, never
// through a shell.
type Config struct {
	Path string    // full path to llama-server.exe
	Args []string  // arguments; the port flag is added by the caller (see FreePort)
	Port int       // port the server listens on, checked for health
	Log  io.Writer // receives stdout and stderr; nil discards
}

// Process is one running (or not yet running) server.
type Process struct {
	cfg Config

	mu    sync.Mutex
	state State
	cmd   *exec.Cmd
	done  chan struct{} // closed when the OS process has exited
}

func New(cfg Config) *Process {
	return &Process{cfg: cfg, state: StateStopped}
}

func (p *Process) State() State {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

// BaseURL is where the router sends requests once the process is ready.
func (p *Process) BaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", p.cfg.Port)
}

// Start launches the program and returns once /health answers 200. If that takes
// longer than timeout, ctx is cancelled, or the program exits first, the process
// is stopped again and an error is returned.
func (p *Process) Start(ctx context.Context, timeout time.Duration) error {
	p.mu.Lock()
	if p.state != StateStopped {
		p.mu.Unlock()
		return fmt.Errorf("process is %s, not stopped", p.state)
	}
	cmd := exec.Command(p.cfg.Path, p.cfg.Args...)
	cmd.Stdout = p.cfg.Log
	cmd.Stderr = p.cfg.Log
	cmd.WaitDelay = waitDelay
	setProcAttributes(cmd)
	if err := cmd.Start(); err != nil {
		p.mu.Unlock()
		return fmt.Errorf("start %s: %w", p.cfg.Path, err)
	}
	done := make(chan struct{})
	p.cmd, p.done, p.state = cmd, done, StateStarting
	p.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		p.mu.Lock()
		p.state = StateStopped
		p.mu.Unlock()
		close(done)
	}()

	if err := p.waitHealthy(ctx, timeout, done); err != nil {
		p.Stop(5 * time.Second)
		return err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	// The process may have died between the last health check and here.
	select {
	case <-done:
		return errors.New("process exited right after becoming healthy")
	default:
	}
	p.state = StateReady
	return nil
}

func (p *Process) waitHealthy(ctx context.Context, timeout time.Duration, done <-chan struct{}) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	client := &http.Client{Timeout: 2 * time.Second}
	url := p.BaseURL() + healthPath
	ticker := time.NewTicker(healthPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return errors.New("process exited before it was ready")
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("health check timed out after %v", timeout)
			}
			return ctx.Err()
		case <-ticker.C:
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			continue // not listening yet
		}
		_ = resp.Body.Close()
		// llama-server answers 503 while the model loads and 200 when ready.
		if resp.StatusCode == http.StatusOK {
			return nil
		}
	}
}

// Stop asks the process tree to exit, force-kills it if it is still alive after
// grace, and returns once it is gone. Stopping a stopped process does nothing.
func (p *Process) Stop(grace time.Duration) {
	p.mu.Lock()
	cmd, done := p.cmd, p.done
	p.mu.Unlock()
	if cmd == nil {
		return
	}

	// On Windows a console program without a window cannot be asked politely, so
	// the request fails fast; then there is no point waiting out the grace period.
	if err := terminateProcessTree(cmd); err == nil {
		select {
		case <-done:
			return
		case <-time.After(grace):
		}
	}
	_ = killProcessTree(cmd)
	<-done
}

// FreePort asks the OS for an unused loopback port. There is a short window
// before the server binds it; acceptable on a single-user PC.
func FreePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}
