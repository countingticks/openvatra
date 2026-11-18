// Command fake-server stands in for llama-server in tests: no model, no GPU.
// Modeled on llama-swap's cmd/simple-responder, but standard library only.
package main

import (
	"flag"
	"fmt"
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
	flag.Parse()

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
