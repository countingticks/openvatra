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
	"strings"
	"time"
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
	flag.Bool("cpu-moe", false, "experts in RAM (ignored)")
	flag.String("mmproj", "", "projector file (ignored)")
	flag.Bool("embeddings", false, "embedding server (ignored)")
	// Like a real server loading a model: /health says 503 until it is done.
	loadTime := flag.Duration("load-time", 0, "answer /health with 503 for this long")
	loadLog := flag.String("load-log", "", "copy this file to stdout before the listening line")
	exitCode := flag.Int("exit", -1, "exit immediately with this code (>= 0)")
	// Chat answers; the environment variables let e2e set them through core, which starts us without cmd.Env.
	reply := flag.String("reply", envOr("FAKE_SERVER_REPLY", "Hello from the fake model."), "the answer to a chat")
	reasoning := flag.String("reasoning", os.Getenv("FAKE_SERVER_REASONING"), "thinking sent before the answer")
	delayText := flag.String("token-delay", envOr("FAKE_SERVER_TOKEN_DELAY", "0"), "wait before every chunk (a Go duration)")
	flag.Parse()
	tokenDelay, err := time.ParseDuration(*delayText)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fake-server: bad --token-delay %q: %v\n", *delayText, err)
		os.Exit(2)
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
	mux.HandleFunc("GET /v1/models", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"object":"list","data":[]}`)
	})
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || !json.Valid(body) {
			http.Error(w, `{"error":{"message":"body is not JSON"}}`, http.StatusBadRequest)
			return
		}
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
		words := func(field, text string) (int, bool) {
			ws := strings.Fields(text)
			for i, word := range ws {
				if i < len(ws)-1 {
					word += " "
				}
				b, _ := json.Marshal(word)
				if !frame(fmt.Sprintf(`{"choices":[{"delta":{%q:%s}}]}`, field, b)) {
					return 0, false
				}
			}
			return len(ws), true
		}
		if _, ok := words("reasoning_content", *reasoning); !ok {
			return
		}
		n, ok := words("content", *reply)
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
