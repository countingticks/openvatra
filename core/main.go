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
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/countingticks/openvatra/core/internal/api"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/process"
	"github.com/countingticks/openvatra/core/internal/router"
)

const version = "0.1.0"

// tokenEnv is the environment variable Electron main passes the per-launch token in.
const tokenEnv = "OPENVATRA_CORE_TOKEN"

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
	// Temporary: main will send the folder through POST /api/config (later task).
	modelsDir := fs.String("models-dir", "", "folder to search for .gguf models")
	llamaServer := fs.String("llama-server", "", "full path to llama-server.exe")
	embeddingModel := fs.String("embedding-model", "", "id of the model that serves /v1/embeddings")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Fail closed: without a token every request would have to be refused anyway.
	token := os.Getenv(tokenEnv)
	if token == "" {
		return fmt.Errorf("%s is not set", tokenEnv)
	}

	// Join a kill-on-close Job Object so llama-servers die with us, even after a crash.
	// Not fatal: the stdin watcher and graceful shutdown still cover normal exits.
	if err := process.SetupTreeCleanup(); err != nil {
		fmt.Fprintln(os.Stderr, "core: job object:", err)
	}

	// Loopback only: never reachable from other PCs.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}

	// With port 0 the real port is only known after listening.
	actualPort := ln.Addr().(*net.TCPAddr).Port
	if err := writeReady(stdout, actualPort); err != nil {
		return err
	}

	// stop is the single "please exit" signal; both triggers below fire it.
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go watchStdin(stdin, stop)

	listModels := func() ([]models.Model, error) { return models.Discover(*modelsDir) }
	rt := router.New(router.Config{
		NewBackend:     newBackendFunc(*llamaServer, *modelsDir),
		EmbeddingModel: func() string { return *embeddingModel },
	})
	defer rt.Close() // after the server is down, so no request is mid-stream
	srv := &http.Server{Handler: api.NewHandler(token, actualPort, stop, listModels, rt)}
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
// give its llama-server a free port, and add --embeddings when asked.
func newBackendFunc(llamaServer, modelsDir string) func(id string, embedding bool) (router.Backend, error) {
	return func(id string, embedding bool) (router.Backend, error) {
		found, err := models.Discover(modelsDir)
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
			args := []string{"-m", m.Path, "--host", "127.0.0.1", "--port", strconv.Itoa(port)}
			if embedding {
				args = append(args, "--embeddings")
			}
			return process.New(process.Config{Path: llamaServer, Args: args, Port: port}), nil
		}
		return nil, router.ErrUnknownModel
	}
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
