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
	"strconv"
	"time"

	"github.com/countingticks/openvatra/core/internal/api"
	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/download"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/hw"
	"github.com/countingticks/openvatra/core/internal/logs"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/process"
	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/router"
	"github.com/countingticks/openvatra/core/internal/store"
)

const version = "0.1.0"

// tokenEnv is the environment variable Electron main passes the per-launch token in.
const tokenEnv = "OPENVATRA_CORE_TOKEN"

// logDirEnv is where Electron main says the logs folder is (core.log goes next to main.log).
const logDirEnv = "OPENVATRA_LOG_DIR"

// shutdownGrace is how long in-flight requests get to finish before we give up.
const shutdownGrace = 5 * time.Second

// defaultContext is the chat context size in tokens: llama-server's own default is the model's full context, which
// can need more memory than the model itself.
const defaultContext = "16384"

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "core:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("core", flag.ContinueOnError)
	port := fs.Int("port", 0, "port to listen on; 0 lets the OS pick a free one")
	// For the end-to-end tests only: main passes it solely when unpackaged with OPENVATRA_E2E=1.
	testCatalog := fs.String("test-catalog", "", "catalog file that replaces the built-in list and may name a local server")
	// Both come from Electron main. Without them core still works; it just can't offer the CUDA engine.
	llamaManifest := fs.String("llama-manifest", "", "llama.json with the pinned llama.cpp builds")
	enginesDir := fs.String("engines-dir", "", "folder the downloaded llama.cpp engines go into")
	dataDir := fs.String("data-dir", "", "folder for chats, attachments and documents; created if missing")
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

	// Not fatal: models and downloads work without chat storage, and the log says why it is missing.
	var chatStore *store.Store
	if *dataDir != "" {
		if db, err := store.Open(*dataDir); err != nil {
			logger.Error("open chat database", "err", err)
		} else {
			defer db.Close()
			chatStore = db
			if err := db.RenameErr(); err != nil {
				logger.Warn("could not rename chats.db to openvatra.db; using the old name this run", "err", err)
			}
			if ro := db.ReadOnly(); ro != nil {
				logger.Warn("chat database is read-only", "err", ro)
			}
		}
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

	var engine *downloads.Engine
	if *llamaManifest != "" && *enginesDir != "" {
		if engine, err = downloads.LoadEngine(*llamaManifest, *enginesDir); err != nil {
			logger.Warn("no CUDA engine offered", "err", err) // a build bug at worst: the rest of core is unaffected
			engine = nil
		}
	}
	env := config.Env{EnginesDir: *enginesDir}
	if engine != nil {
		env.Tag = engine.Tag
	}
	if home, err := os.UserHomeDir(); err == nil {
		env.Home = home
	}

	// Main's POST /api/config (right after core is ready) overrides the defaults while it is set. Every use reads the
	// live value, so a change in Settings applies without restarting core.
	override := config.NewOverride()
	resolve := func() config.Resolved {
		if m, ok := override.Get(); ok {
			return m.Resolve(env)
		}
		return config.DefaultModels().Resolve(env)
	}
	listModels := func() ([]models.Model, error) { return models.Discover(resolve().ModelsDir) }
	rt := router.New(router.Config{
		NewBackend:     newBackendFunc(resolve, logger, logOut),
		EmbeddingModel: func() string { return resolveEmbedding(resolve()) },
		IdleTimeout: func(id string) time.Duration {
			r := resolve()
			if id == resolveEmbedding(r) {
				return 0 // the serving embedding model never unloads, whichever way it was chosen
			}
			return r.IdleTimeout()
		},
	})
	override.OnChange(rt.Notify)
	var chats *chat.Service
	if chatStore != nil {
		chats = &chat.Service{Store: chatStore, Router: rt, Sizes: &prompt.ContextSizes{}, Logger: logger}
	}
	// Asks the engine main configured, so its answer matches the GPUs llama-server will really use.
	hardware := hw.NewChecker(func() string { return resolve().LlamaServerPath }, logger)
	entries, err := catalog.Builtin()
	if err != nil {
		return fmt.Errorf("built-in catalog: %w", err) // a build bug; its test keeps it from shipping
	}
	dler := download.New()
	if *testCatalog != "" {
		data, err := os.ReadFile(*testCatalog)
		if err != nil {
			return fmt.Errorf("test catalog: %w", err)
		}
		if entries, err = catalog.ParseTest(data); err != nil {
			return fmt.Errorf("test catalog: %w", err)
		}
		dler.AllowLocalHTTP = true
		dler.AllowHost = func(h string) bool { return download.HuggingFaceHost(h) || h == "127.0.0.1" || h == "localhost" }
		logger.Warn("using a test catalog", "file", *testCatalog)
	}
	cat := catalog.New(entries, hardware.Get, func() string { return resolve().ModelsDir })
	// A finished download changes what is on disk: tell every listener to re-read the models.
	dl := downloads.New(downloads.Config{
		Downloader: dler,
		Entries:    entries,
		ModelsDir:  func() string { return resolve().ModelsDir },
		OnFinish:   rt.Notify,
		Engine:     engine,
	})
	defer dl.Close()
	defer rt.Close() // after the server is down, so no request is mid-stream
	// BaseContext ties every request to ctx: once we are told to exit, long-lived requests (the event stream the UI
	// keeps open) end at once instead of making Shutdown wait out its whole grace period.
	srv := &http.Server{
		Handler:     api.NewHandler(token, actualPort, stop, listModels, rt, override, hardware, cat, dl, chats),
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

// resolveEmbedding is the id of the embedding model that serves under c: the chosen one if it is an embedding model,
// else the first one found (Automatic), else "".
func resolveEmbedding(c config.Resolved) string {
	found, err := models.Discover(c.ModelsDir)
	if err != nil {
		return ""
	}
	return models.ResolveEmbedding(found, c.EmbeddingModel)
}

// newBackendFunc builds the router's server factory: look the model up on disk,
// give its llama-server a free port, and add --embeddings when asked. Its output
// goes to core.log, every line prefixed with the model id.
func newBackendFunc(resolve func() config.Resolved, logger *slog.Logger, logOut io.Writer) func(id string, embedding bool) (router.Backend, error) {
	return func(id string, embedding bool) (router.Backend, error) {
		c := resolve() // one snapshot, so a config change mid-call can't mix old and new values
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
func serverArgs(c config.Resolved, m models.Model, port int, embedding bool) []string {
	args := []string{"-m", m.Path, "--host", "127.0.0.1", "--port", strconv.Itoa(port)}
	if embedding {
		args = append(args, "--embeddings")
	} else {
		// The catalog's memory estimates assume this context; the user's own -c comes later and wins.
		args = append(args, "-c", defaultContext)
	}
	// Embedding servers never take images, so a projector would only cost memory there.
	if m.MMProj != "" && !embedding && c.UseMMProj(m.ID) {
		args = append(args, "--mmproj", m.MMProj)
	}
	return append(args, modelArgs(c, m.ID)...)
}

// modelArgs are the user's arguments for one model. A copy, so appending to it never writes into the config.
func modelArgs(c config.Resolved, id string) []string {
	return c.Args(id)
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
