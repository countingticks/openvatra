// Command fake-server stands in for llama-server in tests: no model, no GPU.
// Modeled on llama-swap's cmd/simple-responder, but standard library only.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	port := flag.Int("port", 8080, "port to listen on")
	// Like a real server loading a model: /health says 503 until it is done.
	loadTime := flag.Duration("load-time", 0, "answer /health with 503 for this long")
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

	fmt.Printf("fake-server listening on 127.0.0.1:%d\n", *port)
	if err := http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *port), mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
