// Command core is OpenVatra's local models service. Electron starts it, reads the
// ready line from stdout and then talks to it over HTTP on 127.0.0.1.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/api"
	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/chat"
	"github.com/countingticks/openvatra/core/internal/config"
	"github.com/countingticks/openvatra/core/internal/download"
	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/feed"
	"github.com/countingticks/openvatra/core/internal/host"
	"github.com/countingticks/openvatra/core/internal/hw"
	"github.com/countingticks/openvatra/core/internal/logs"
	"github.com/countingticks/openvatra/core/internal/models"
	"github.com/countingticks/openvatra/core/internal/process"
	"github.com/countingticks/openvatra/core/internal/prompt"
	"github.com/countingticks/openvatra/core/internal/removal"
	"github.com/countingticks/openvatra/core/internal/router"
	"github.com/countingticks/openvatra/core/internal/store"
	"github.com/countingticks/openvatra/core/internal/trash"
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
	err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "core:", err)
	}
	os.Exit(exitCode(err))
}

// exitCode maps run's result to the process exit code: 0 clean, 3 another core holds the folder, 1 anything else.
func exitCode(err error) int {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, host.ErrRunning):
		return host.ExitRunning
	default:
		return 1
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("core", flag.ContinueOnError)
	port := fs.Int("port", 0, "port to listen on; 0 lets the OS pick a free one")
	// For the end-to-end tests only: main passes it solely when unpackaged with OPENVATRA_E2E=1.
	testCatalog := fs.String("test-catalog", "", "catalog file that replaces the built-in list and may name a local server")
	// Both come from Electron main. Without them core still works; it just can't offer the CUDA engine.
	llamaManifest := fs.String("llama-manifest", "", "llama.json with the pinned llama.cpp builds")
	enginesDir := fs.String("engines-dir", "", "folder the downloaded llama.cpp engines go into")
	dataDir := fs.String("data-dir", "", "folder for chats, attachments and documents; created if missing")
	// Without it core knows no default engine and runs no model until a path is chosen.
	llamaDir := fs.String("llama-dir", "", "folder holding the bundled llama-server.exe")
	openapi := fs.Bool("openapi", false, "print the OpenAPI document to stdout and exit")
	// So a killed e2e test leaves no orphan core behind.
	parentPID := fs.Int("parent-pid", 0, "pid whose exit stops core (e2e tests)")
	detach := fs.Bool("detach", false, "start a core detached from this process, print its ready line and exit")
	stopFlag := fs.Bool("stop", false, "stop the core running on --data-dir and exit")
	// Pages from these origins may call core (with a token); main passes the dev server's in development only.
	var origins []string
	fs.Func("origin", "an origin (scheme://host[:port]) whose pages may call core; repeatable", func(v string) error {
		origins = append(origins, v)
		return nil
	})
	if err := fs.Parse(args); err != nil {
		return err
	}
	for _, o := range origins {
		if !isOrigin(o) {
			return fmt.Errorf("--origin %q is not scheme://host[:port]", o)
		}
	}
	var modes []string
	for name, on := range map[string]bool{"--openapi": *openapi, "--detach": *detach, "--stop": *stopFlag} {
		if on {
			modes = append(modes, name)
		}
	}
	if len(modes) > 1 {
		slices.Sort(modes)
		return fmt.Errorf("%s cannot be used together", strings.Join(modes, " and "))
	}

	// Nothing is opened or read: the document comes from the route table alone, so it needs no token.
	if *openapi {
		cfg := config.New(nil, nil)
		registerSections(cfg, config.Env{})
		_, err := stdout.Write(api.Document(api.Deps{Version: version, Config: cfg}))
		return err
	}
	if *dataDir == "" {
		return errors.New("--data-dir is required")
	}

	// Both run before the logs, the lock and the job object: the launcher must never join a kill-on-close job, or
	// the core it starts would die with it.
	if *stopFlag {
		return stopCore(*dataDir, stderr)
	}
	if *detach {
		return detachCore(dropFlags(args, []string{"detach"}, nil), *dataDir, stdout, stderr)
	}

	// Child mode: the app started us and passed the token. Otherwise core makes its own and publishes it in core.json.
	token := os.Getenv(tokenEnv)
	childMode := token != ""
	if !childMode {
		t, err := newShellToken()
		if err != nil {
			return err
		}
		token = t
	}

	logger, logOut, logCloser, err := logs.Setup(os.Getenv(logDirEnv))
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer logCloser.Close()
	logger.Info("core starting", "version", version)
	defer logger.Info("core stopped")

	// Before the database and the port: two cores must never share openvatra.db. Closed last, after everything else.
	lock, err := host.Lock(*dataDir)
	if errors.Is(err, host.ErrLocked) {
		logger.Warn("another core is running on this data folder")
		return host.ErrRunning
	}
	if err != nil {
		return fmt.Errorf("lock data folder: %w", err)
	}
	defer lock.Close()

	// stop is the single "please exit" signal; /shutdown, the parent's exit and stdin's EOF fire it.
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	if *parentPID != 0 {
		err := host.WatchParent(*parentPID, stop)
		if errors.Is(err, host.ErrNoProcess) {
			return fmt.Errorf("parent process %d is not running", *parentPID)
		}
		if err != nil {
			return fmt.Errorf("watch parent process %d: %w", *parentPID, err)
		}
	}

	// Join a kill-on-close Job Object so llama-servers die with us, even after a crash.
	// Not fatal: the stdin watcher and graceful shutdown still cover normal exits.
	if err := process.SetupTreeCleanup(); err != nil {
		logger.Warn("job object setup failed", "err", err)
	}

	bus := event.NewBus(256)

	// Not fatal: models and downloads work without chat storage, and the log says why it is missing.
	var chatStore *store.Store
	var cfgDB config.DB // an untyped nil without a database, never a nil *store.Store inside the interface
	eventLog := event.MemoryLog(bus)
	if db, err := store.Open(*dataDir, bus); err != nil {
		logger.Error("open chat database", "err", err)
	} else {
		defer db.Close()
		chatStore, cfgDB, eventLog = db, db, db.Log()
		if err := db.RenameErr(); err != nil {
			logger.Warn("could not rename chats.db to openvatra.db; using the old name this run", "err", err)
		}
		if ro := db.ReadOnly(); ro != nil {
			logger.Warn("chat database is read-only", "err", ro)
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
	if err := writeReady(stdout, actualPort, os.Getpid()); err != nil {
		return err
	}

	// Fatal when it fails: a core nobody can find would hold the lock for nothing. The token goes in the file only.
	d := host.Discovery{PID: os.Getpid(), Port: actualPort, Token: token, Version: version, API: api.APILevel,
		Args: hostArgs(args), StartedAt: time.Now().UTC()}
	if d.Exe, err = exePath(); err == nil {
		err = host.WriteDiscovery(*dataDir, d)
	}
	if err != nil {
		ln.Close()
		return fmt.Errorf("write core.json: %w", err)
	}
	logger.Info("wrote core.json", "port", actualPort, "pid", d.PID)
	defer func() {
		if err := host.RemoveDiscovery(*dataDir, d.PID); err != nil {
			logger.Warn("could not remove core.json", "err", err)
		}
	}()

	// Only the app's child core reads stdin: a core started with --detach or from a terminal has stdin on NUL or a
	// console and must not stop at its EOF.
	if childMode {
		go watchStdin(stdin, stop)
	}
	if chatStore != nil && chatStore.ReadOnly() == nil {
		go trimSystemEvents(ctx, chatStore, 24*time.Hour, time.Now, logger)
	}

	var engine *downloads.Engine
	if *llamaManifest != "" && *enginesDir != "" {
		if engine, err = downloads.LoadEngine(*llamaManifest, *enginesDir); err != nil {
			logger.Warn("no CUDA engine offered", "err", err) // a build bug at worst: the rest of core is unaffected
			engine = nil
		}
	}
	env := config.Env{LlamaDir: *llamaDir, EnginesDir: *enginesDir}
	if engine != nil {
		env.Tag = engine.Tag
	}
	if home, err := os.UserHomeDir(); err == nil {
		env.Home = home
	}

	// The models section lives in openvatra.db and is the only model config. Every use reads the live value, so a
	// change in Settings applies without restarting core.
	cfg := config.New(cfgDB, logger)
	registerSections(cfg, env)
	resolve := func() config.Resolved { return config.Get[config.Models](cfg, config.ModelsSection).Resolve(env) }
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
	cfg.Subscribe(func(section string, _ int) {
		if section == config.ModelsSection {
			rt.Notify() // a new models folder changes the list although no model changed state
		}
	})
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
		Downloader:    dler,
		Entries:       entries,
		ModelsDir:     func() string { return resolve().ModelsDir },
		OnFinish:      rt.Notify,
		OnEngineReady: func() { switchToCUDA(cfg, logger) },
		Engine:        engine,
	})
	defer dl.Close()
	remover := removal.New(removal.Config{
		Router: rt, Catalog: cat, Downloads: dl, ModelsDir: func() string { return resolve().ModelsDir },
		Trash: trash.Move, Logger: logger,
	})
	pinned := downloads.PinnedTag(*llamaManifest)
	engines := func() downloads.EnginesBody { return downloads.Engines(*llamaDir, *enginesDir, pinned) }
	feed.Start(ctx, eventLog, rt, listModels, dl)
	defer rt.Close() // after the server is down, so no request is mid-stream
	// BaseContext ties every request to ctx: once we are told to exit, long-lived requests (the event stream the UI
	// keeps open) end at once instead of making Shutdown wait out its whole grace period.
	srv := &http.Server{
		Handler: api.NewHandler(api.Deps{
			Token: token, Origins: origins, Port: actualPort, Version: version, Shutdown: stop, ListModels: listModels, Router: rt,
			Config: cfg, Hardware: hardware, Catalog: cat, Removal: remover, Downloads: dl, Engines: engines,
			Chats: chats, Log: eventLog, Logger: logger,
		}),
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

// isOrigin reports whether v is an origin as a browser sends it: a scheme and a host, an optional port, nothing else.
func isOrigin(v string) bool {
	u, err := url.Parse(v)
	return err == nil && u.Scheme != "" && u.Host != "" && u.Opaque == "" && u.User == nil && u.Path == "" &&
		u.RawQuery == "" && !u.ForceQuery && u.Fragment == ""
}

// registerSections registers every config section on cfg; run and --openapi share it.
func registerSections(cfg *config.Store, env config.Env) {
	config.Register(cfg, config.ModelsSection, config.DefaultModels(), effectiveModels(env))
}

// effectiveModels is the models section's read-only view: the paths core really uses when none is chosen.
func effectiveModels(env config.Env) func(config.Models) config.ModelsEffective {
	return func(m config.Models) config.ModelsEffective {
		r := m.Resolve(env)
		return config.ModelsEffective{LlamaServerPath: r.LlamaServerPath, ModelsDir: r.ModelsDir}
	}
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

// newShellToken makes the shell token of a core that was not given one: 32 random bytes as lowercase hex.
func newShellToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("make token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// dropFlags removes the named bool flags and the named flags that take a value, order kept.
func dropFlags(args []string, bools, valued []string) []string {
	out := []string{}
	for i := 0; i < len(args); i++ {
		name, hasValue, ok := flagName(args[i])
		switch {
		case ok && slices.Contains(bools, name):
		case ok && slices.Contains(valued, name):
			if !hasValue {
				i++ // the value is the next argument
			}
		default:
			out = append(out, args[i])
		}
	}
	return out
}

// flagName splits "-name", "--name" or either with "=value" into the name and whether the value is attached.
func flagName(arg string) (name string, hasValue, ok bool) {
	if !strings.HasPrefix(arg, "-") || arg == "-" || arg == "--" {
		return "", false, false
	}
	name = strings.TrimPrefix(strings.TrimPrefix(arg, "-"), "-")
	name, _, hasValue = strings.Cut(name, "=")
	return name, hasValue, true
}

// hostArgs is the fingerprint part of our arguments: everything but the flags that only say how this run started.
func hostArgs(args []string) []string {
	return dropFlags(args, []string{"detach"}, []string{"port", "parent-pid"})
}

// exePath is this executable's real path, symlinks resolved, so two starts of the same build compare equal.
func exePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// writeReady prints the one JSON line main waits for.
func writeReady(w io.Writer, port, pid int) error {
	return json.NewEncoder(w).Encode(map[string]any{
		"event":   "ready",
		"port":    port,
		"pid":     pid,
		"version": version,
	})
}

// detachTimeout is how long the launcher waits for the core it started to write core.json.
const detachTimeout = 15 * time.Second

// detachCore starts this exe with args as a core that outlives us and prints its ready line. The core is the same
// build, so the ready line's version is ours.
func detachCore(args []string, dataDir string, stdout, stderr io.Writer) error {
	exe, err := exePath()
	if err != nil {
		return err
	}
	r, err := host.Detach(exe, args, dataDir, detachTimeout)
	if errors.Is(err, host.ErrRunning) {
		if _, err := fmt.Fprintln(stdout, `{"event":"running"}`); err != nil {
			return err
		}
		return host.ErrRunning
	}
	if err != nil {
		return err
	}
	if !r.Breakaway {
		fmt.Fprintln(stderr, "core: started without breakaway from the job; it may stop with its starter")
	}
	return writeReady(stdout, r.Port, r.PID)
}

// Vars so tests can shorten them.
var (
	stopRequestTimeout = 3 * time.Second // a core that does not answer /shutdown by then counts as hung
	stopWait           = 8 * time.Second // how long a stopping core gets to exit
)

// stopCore asks the core named by dataDir's core.json to shut down and waits for it to exit. No core, or a stale file
// whose core does not answer as ours, is not an error: there is nothing to stop. It never kills and never deletes
// core.json, and the token never reaches stderr.
func stopCore(dataDir string, stderr io.Writer) error {
	d, err := host.ReadDiscovery(dataDir)
	if errors.Is(err, host.ErrNoDiscovery) {
		fmt.Fprintln(stderr, "core: no core is running")
		return nil
	}
	if err != nil {
		fmt.Fprintln(stderr, "core: core.json is unreadable:", err)
		return nil
	}

	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/shutdown", d.Port), nil)
	if err != nil {
		fmt.Fprintf(stderr, "core: no core from core.json is running (%v)\n", err)
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+d.Token)
	resp, err := (&http.Client{Timeout: stopRequestTimeout}).Do(req)
	var netErr net.Error
	switch {
	case err == nil:
		resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			fmt.Fprintf(stderr, "core: no core from core.json is running (status %d)\n", resp.StatusCode)
			return nil
		}
	case errors.As(err, &netErr) && netErr.Timeout():
		// Connected but no answer: a hung core, so wait on its pid as after a 202.
	default:
		// A refused connection: the file is stale and its pid may already belong to another process.
		fmt.Fprintf(stderr, "core: no core from core.json is running (%v)\n", err)
		return nil
	}

	exited, err := host.WaitExit(d.PID, stopWait)
	if err != nil {
		return err
	}
	if !exited {
		return fmt.Errorf("core (pid %d) is still running", d.PID)
	}
	return nil
}

// sectionWriter is the part of the config store switchToCUDA uses.
type sectionWriter interface {
	Section(name string) (config.SectionEntry, error)
	Put(name string, rev int, value json.RawMessage) (config.SectionEntry, error)
}

// systemRetention is how long system events are kept; other streams are never trimmed.
const systemRetention = 30 * 24 * time.Hour

type systemTrimmer interface {
	TrimSystem(ctx context.Context, before time.Time) (int64, error)
}

// trimSystemEvents trims old system events at once and then every `every` until ctx ends. A failed trim is logged
// and tried again next time.
func trimSystemEvents(ctx context.Context, t systemTrimmer, every time.Duration, now func() time.Time, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		n, err := t.TrimSystem(ctx, now().Add(-systemRetention))
		switch {
		case err != nil:
			logger.Error("trim system events", "err", err)
		case n > 0:
			logger.Info("trimmed old system events", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if ctx.Err() != nil { // both were ready and select picked the tick
			return
		}
	}
}

// switchToCUDA stores engine "cuda" once its download is finished. A concurrent write (a Settings save) may win the
// revision, so it reads again and retries once; after that it gives up and logs, because the user can still pick the
// engine by hand and core must not loop.
func switchToCUDA(cfg sectionWriter, logger *slog.Logger) {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		var entry config.SectionEntry
		if entry, err = cfg.Section(config.ModelsSection); err != nil {
			break
		}
		var m config.Models
		if err = json.Unmarshal(entry.Value, &m); err != nil {
			break
		}
		if m.Engine == "cuda" {
			return
		}
		m.Engine = "cuda"
		var value []byte
		if value, err = json.Marshal(m); err != nil {
			break
		}
		if _, err = cfg.Put(config.ModelsSection, entry.Rev, value); !errors.Is(err, config.ErrConflict) {
			break
		}
	}
	switch {
	case err == nil:
	case errors.Is(err, config.ErrUnavailable):
		logger.Warn("could not switch to the CUDA engine: config storage is not available")
	default:
		logger.Error("could not switch to the CUDA engine", "err", err)
	}
}
