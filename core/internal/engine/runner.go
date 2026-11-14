// Runner runs one server program: start it, wait until it answers its health check, stop it. The shape follows
// llama-swap's process package, cut down to what core needs (no TTL, no config parsing, no proxying; the router
// adds those).
package engine

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

const (
	healthPollInterval = 250 * time.Millisecond
	// waitDelay bounds how long Wait lingers for output pipes after the process exits.
	// Without it a grandchild holding stdout open would make Stop hang forever.
	waitDelay = 2 * time.Second
	// failStopGrace is how long a failed start lets the process exit before killing it.
	failStopGrace = 5 * time.Second
)

// Command is one program to run. Args never go through a shell.
type Command struct {
	Path     string
	Args     []string // without the port
	PortFlag string   // "--port"
	Health   string   // "/health"; 200 means ready
}

// Runner starts server programs. The zero Runner is ready to use; each Start is its own process.
type Runner struct {
	port func() (int, error) // nil = a free loopback port from the OS; tests fix it
}

// Start runs cmd on a free port and returns once its health path answers 200. The deadline of ctx is the load
// timeout. On any error after the process started its tree is stopped before Start returns.
func (r *Runner) Start(ctx context.Context, cmd Command, log io.Writer) (Instance, error) {
	portFn := r.port
	if portFn == nil {
		portFn = freePort
	}
	port, err := portFn()
	if err != nil {
		return nil, err
	}
	args := append(append([]string{}, cmd.Args...), cmd.PortFlag, fmt.Sprint(port))
	c := exec.Command(cmd.Path, args...)
	c.Stdout = log
	c.Stderr = log
	c.WaitDelay = waitDelay
	setProcAttributes(c)
	begin := time.Now()
	if err := c.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", cmd.Path, err)
	}
	inst := &instance{port: port, cmd: c, state: StateStarting, done: make(chan struct{})}
	go func() {
		_ = c.Wait()
		inst.mu.Lock()
		inst.state = StateStopped
		inst.mu.Unlock()
		close(inst.done)
	}()

	if err := waitHealthy(ctx, inst.BaseURL()+cmd.Health, begin, inst.done); err != nil {
		inst.Stop(failStopGrace)
		return nil, err
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()
	// The process may have died between the last health check and here.
	select {
	case <-inst.done:
		return nil, errors.New("process exited right after becoming healthy")
	default:
	}
	inst.state = StateReady
	return inst, nil
}

func waitHealthy(ctx context.Context, url string, begin time.Time, done <-chan struct{}) error {
	client := &http.Client{Timeout: 2 * time.Second}
	ticker := time.NewTicker(healthPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return errors.New("process exited before it was ready")
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				d := time.Duration(0)
				if dl, ok := ctx.Deadline(); ok {
					d = dl.Sub(begin).Round(time.Second)
				}
				return fmt.Errorf("health check timed out after %v", d)
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

type instance struct {
	port int
	cmd  *exec.Cmd
	done chan struct{} // closed when the OS process has exited

	mu    sync.Mutex
	state State
}

func (i *instance) State() State {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.state
}

func (i *instance) BaseURL() string { return fmt.Sprintf("http://127.0.0.1:%d", i.port) }

func (i *instance) Wait() <-chan struct{} { return i.done }

// Stop asks the process tree to exit, force-kills it if it is still alive after grace, and returns once it is
// gone. Stopping a stopped instance does nothing.
func (i *instance) Stop(grace time.Duration) {
	select {
	case <-i.done:
		return
	default:
	}
	// On Windows a console program without a window cannot be asked politely, so
	// the request fails fast; then there is no point waiting out the grace period.
	if err := terminateProcessTree(i.cmd); err == nil {
		select {
		case <-i.done:
			return
		case <-time.After(grace):
		}
	}
	_ = killProcessTree(i.cmd)
	<-i.done
}

// freePort asks the OS for an unused loopback port. There is a short window
// before the server binds it; acceptable on a single-user PC.
func freePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}
