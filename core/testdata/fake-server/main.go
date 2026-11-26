// Command fake-server stands in for llama-server in tests: no model, no GPU.
// Modeled on llama-swap's cmd/simple-responder, but standard library only.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

func main() {
	port := flag.Int("port", 8080, "port to listen on")
	// core always passes these; the fake accepts and ignores them (flag exits on one it doesn't know).
	flag.String("m", "", "model file (ignored)")
	flag.String("host", "127.0.0.1", "address (ignored; the fake always binds to 127.0.0.1)")
	flag.Int("c", 0, "context size (ignored)")
	flag.String("ngl", "", "layers on the GPU (ignored)")
	flag.String("fit", "", "llama-server's own fitting (ignored)")
	flag.Int("lv", 0, "log verbosity (ignored)")
	flag.Int("fitt", 0, "fit margin (ignored)")
	flag.String("fa", "", "flash attention (ignored)")
	flag.String("ctk", "", "K cache type (ignored)")
	flag.String("ctv", "", "V cache type (ignored)")
	flag.Int("np", 0, "slots (ignored)")
	flag.Int("ub", 0, "micro batch (ignored)")
	flag.Bool("cpu-moe", false, "experts in RAM (ignored)")
	flag.String("mmproj", "", "projector file (ignored)")
	flag.Bool("embeddings", false, "embedding server (ignored)")
	// Like a real server loading a model: /health says 503 until it is done.
	loadTime := flag.Duration("load-time", 0, "answer /health with 503 for this long")
	loadLog := flag.String("load-log", "", "copy this file to stdout before the listening line")
	exitCode := flag.Int("exit", -1, "exit immediately with this code (>= 0)")
	// Chat answers; the environment variables let e2e set them through core, which starts us without cmd.Env.
	reply := flag.String("reply", envOr("FAKE_SERVER_REPLY", "Hello from the fake model."), "the answer to a chat")
	replyFile := flag.String("reply-file", os.Getenv("FAKE_SERVER_REPLY_FILE"), "read the answer from this file (wins over --reply)")
	reasoning := flag.String("reasoning", os.Getenv("FAKE_SERVER_REASONING"), "thinking sent before the answer")
	delayText := flag.String("token-delay", envOr("FAKE_SERVER_TOKEN_DELAY", "0"), "wait before every chunk (a Go duration)")
	burnDefault, burnErr := burnEnv()
	burnCPU := flag.Int("burn-cpu", burnDefault, "spin this many cores while a chat streams (-1 = every logical CPU, 0 = off)")
	flag.Parse()
	if burnErr != nil || *burnCPU < -1 {
		value := fmt.Sprint(*burnCPU)
		if burnErr != nil {
			value = os.Getenv("FAKE_SERVER_BURN_CPU")
		}
		fmt.Fprintf(os.Stderr, "fake-server: bad --burn-cpu %s\n", value)
		os.Exit(2)
	}
	if *burnCPU == -1 {
		*burnCPU = runtime.NumCPU()
	}
	burn := &burner{n: *burnCPU}
	tokenDelay, err := time.ParseDuration(*delayText)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fake-server: bad --token-delay %q: %v\n", *delayText, err)
		os.Exit(2)
	}

	if *replyFile != "" {
		data, err := os.ReadFile(*replyFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fake-server: reading --reply-file: %v\n", err)
			os.Exit(2)
		}
		*reply = string(data)
	}

	if *exitCode >= 0 {
		os.Exit(*exitCode)
	}

	started := time.Now()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if time.Since(started) < *loadTime {
			http.Error(w, `{"error":{"message":"Loading model"}}`, http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	mux.HandleFunc("GET /debug/burn", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"workers":%d}`, burn.workers.Load())
	})
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"object":"list","data":[]}`)
	})
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || !json.Valid(body) {
			http.Error(w, `{"error":{"message":"body is not JSON"}}`, http.StatusBadRequest)
			return
		}
		burn.enter()
		defer burn.leave()
		// Like a real server, max_tokens caps the answer; thinking doesn't count here, so a title call stays short.
		var opts struct {
			MaxTokens int `json:"max_tokens"`
		}
		json.Unmarshal(body, &opts)
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		frame := func(data string) bool {
			if tokenDelay > 0 {
				select {
				case <-time.After(tokenDelay):
				case <-r.Context().Done():
					return false
				}
			}
			if r.Context().Err() != nil {
				return false
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			if fl != nil {
				fl.Flush()
			}
			return true
		}
		words := func(field, text string, limit int) (int, bool) {
			ws := chunks(text)
			if limit > 0 && len(ws) > limit {
				ws = ws[:limit]
			}
			for _, word := range ws {
				b, _ := json.Marshal(word)
				if !frame(fmt.Sprintf(`{"choices":[{"delta":{%q:%s}}]}`, field, b)) {
					return 0, false
				}
			}
			return len(ws), true
		}
		if _, ok := words("reasoning_content", *reasoning, 0); !ok {
			return
		}
		n, ok := words("content", *reply, opts.MaxTokens)
		if !ok {
			return
		}
		frame(`{"choices":[{"delta":{},"finish_reason":"stop"}]}`)
		frame(fmt.Sprintf(`{"choices":[],"usage":{"prompt_tokens":%d,"completion_tokens":%d},"timings":{"predicted_per_second":20}}`,
			len(body)/4, n))
		frame("[DONE]")
	})

	if *loadLog != "" {
		data, err := os.ReadFile(*loadLog)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Stdout.Write(data)
	}
	fmt.Printf("fake-server listening on 127.0.0.1:%d\n", *port)
	fmt.Printf("fake-server args: %s\n", strings.Join(os.Args[1:], " "))
	if err := http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *port), mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// chunks splits text into runs of non-whitespace, each with the whitespace right after it; whitespace before the
// first word leads the first chunk. Joined, they give the text back byte for byte.
func chunks(text string) []string {
	var out []string
	start, seenWord, prevSpace := 0, false, false
	for i, r := range text {
		space := unicode.IsSpace(r)
		if !space && prevSpace && seenWord {
			out = append(out, text[start:i])
			start = i
		}
		if !space {
			seenWord = true
		}
		prevSpace = space
	}
	if seenWord {
		out = append(out, text[start:])
	}
	return out
}

// burnEnv reads FAKE_SERVER_BURN_CPU: unset or empty is 0.
func burnEnv() (int, error) {
	v := os.Getenv("FAKE_SERVER_BURN_CPU")
	if v == "" {
		return 0, nil
	}
	return strconv.Atoi(v)
}

// burner keeps n cores busy while at least one chat stream is active, to measure the UI on a loaded machine.
type burner struct {
	n       int
	workers atomic.Int32 // spinning right now; reads 0 only once every worker has really returned
	mu      sync.Mutex
	active  int
	stop    chan struct{}
}

func (b *burner) enter() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.active++
	if b.active != 1 || b.n == 0 {
		return
	}
	b.stop = make(chan struct{})
	for range b.n {
		go b.spin(b.stop)
	}
}

func (b *burner) leave() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.active--
	if b.active == 0 && b.stop != nil {
		close(b.stop)
		b.stop = nil
	}
}

func (b *burner) spin(stop chan struct{}) {
	runtime.LockOSThread()
	b.workers.Add(1)
	defer b.workers.Add(-1)
	x := uint64(1)
	for {
		select {
		case <-stop:
			return
		default:
		}
		for range 100000 {
			x = x*6364136223846793005 + 1442695040888963407
		}
		if x == 0 {
			return // keeps the loop from being optimised away
		}
	}
}
