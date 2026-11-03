// Command core is OpenVatra's local models service. Electron starts it, reads the
// ready line from stdout and then talks to it over HTTP on 127.0.0.1.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"time"

	"github.com/countingticks/openvatra/core/internal/api"
	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/logs"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/process"
	"github.com/countingticks/openvatra/core/internal/router"
)

const version = "0.1.0"

// tokenEnv is the environment variable Electron main passes the per-launch token in.
const tokenEnv = "OPENVATRA_CORE_TOKEN"

// logDirEnv is where Electron main says the logs folder is (core.log goes next to main.log).
const logDirEnv = "OPENVATRA_LOG_DIR"

// shutdownGrace is how long in-flight requests get to finish before we give up.
const shutdownGrace = 5 * time.Second

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "core:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("core", flag.ContinueOnError)
	port := fs.Int("port", 0, "port to listen on; 0 lets the OS pick a free one")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Fail closed: without a token every request would have to be refused anyway.
	token := os.Getenv(tokenEnv)
	if token == "" {
		return fmt.Errorf("%s is not set", tokenEnv)
	}

	logger, logOut, logCloser, err := logs.Setup(os.Getenv(logDirEnv))
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer logCloser.Close()
	logger.Info("core starting", "version", version)
	defer logger.Info("core stopped")

	// Join a kill-on-close Job Object so llama-servers die with us, even after a crash.
	// Not fatal: the stdin watcher and graceful shutdown still cover normal exits.
	if err := process.SetupTreeCleanup(); err != nil {
		logger.Warn("job object setup failed", "err", err)
	}

	// Loopback only: never reachable from other PCs.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}

	// With port 0 the real port is only known after listening.
	actualPort := ln.Addr().(*net.TCPAddr).Port
	logger.Info("listening", "port", actualPort)
	if err := writeReady(stdout, actualPort); err != nil {
		return err
	}

	// stop is the single "please exit" signal; both triggers below fire it.
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go watchStdin(stdin, stop)

	// Empty until main sends POST /api/config (right after core is ready). Every use reads the live value, so a
	// change in Settings applies without restarting core.
	cfg := config.NewStore()
	listModels := func() ([]models.Model, error) { return models.Discover(cfg.Get().ModelsDir) }
	rt := router.New(router.Config{
		NewBackend:     newBackendFunc(cfg, logger, logOut),
		EmbeddingModel: func() string { return cfg.Get().EmbeddingModel },
		IdleTimeout:    func(id string) time.Duration { return cfg.Get().IdleTimeout(id) },
	})
	cfg.OnChange(rt.Notify)
	defer rt.Close() // after the server is down, so no request is mid-stream
	// BaseContext ties every request to ctx: once we are told to exit, long-lived requests (the event stream the UI
	// keeps open) end at once instead of making Shutdown wait out its whole grace period.
	srv := &http.Server{
		Handler:     api.NewHandler(token, actualPort, stop, listModels, rt, cfg),
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()

	select {
	case err := <-serveErr:
		return err // the listener failed on its own
	case <-ctx.Done():
	}

	// Shutdown stops accepting, lets running requests finish, then returns.
	shutCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		return err
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// newBackendFunc builds the router's server factory: look the model up on disk,
// give its llama-server a free port, and add --embeddings when asked. Its output
// goes to core.log, every line prefixed with the model id.
func newBackendFunc(cfg *config.Store, logger *slog.Logger, logOut io.Writer) func(id string, embedding bool) (router.Backend, error) {
	return func(id string, embedding bool) (router.Backend, error) {
		c := cfg.Get() // one snapshot, so a config change mid-call can't mix old and new values
		found, err := models.Discover(c.ModelsDir)
		if err != nil {
			return nil, err
		}
		for _, m := range found {
			if m.ID != id {
				continue
			}
			port, err := process.FreePort()
			if err != nil {
				return nil, err
			}
			args := serverArgs(c, m, port, embedding)
			logger.Info("starting llama-server", "model", m.ID, "port", port, "embedding", embedding)
			return process.New(process.Config{Path: c.LlamaServerPath, Args: args, Port: port, Log: logs.Prefixed(logOut, m.ID)}), nil
		}
		logger.Warn("unknown model requested", "model", id)
		return nil, router.ErrUnknownModel
	}
}

// serverArgs is one llama-server's full argument list: core's own flags first, then the user's.
func serverArgs(c config.Config, m models.Model, port int, embedding bool) []string {
	args := []string{"-m", m.Path, "--host", "127.0.0.1", "--port", strconv.Itoa(port)}
	if embedding {
		args = append(args, "--embeddings")
	}
	// Embedding servers never take images, so a projector would only cost memory there.
	if m.MMProj != "" && !embedding && c.UseMMProj(m.ID) {
		args = append(args, "--mmproj", m.MMProj)
	}
	return append(args, modelArgs(c, m.ID)...)
}

// modelArgs are the user's arguments for one model: the shared ones, then the model's own, so the model's win
// (llama-server keeps the last value of a repeated flag).
func modelArgs(c config.Config, id string) []string {
	return append(slices.Clone(c.SharedArgs), c.Options[id].Args...)
}

// watchStdin blocks until stdin is closed, then calls onClose. Electron never
// writes to our stdin; the pipe only closes when it exits or crashes, so EOF
// means "parent died" and we must not linger as an orphan.
func watchStdin(stdin io.Reader, onClose func()) {
	_, _ = io.Copy(io.Discard, stdin)
	onClose()
}

// writeReady prints the one JSON line main waits for.
func writeReady(w io.Writer, port int) error {
	return json.NewEncoder(w).Encode(map[string]any{
		"event":   "ready",
		"port":    port,
		"version": version,
	})
}
