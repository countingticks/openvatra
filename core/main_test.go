package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestWriteReadyIsOneJSONLine(t *testing.T) {
	var buf bytes.Buffer
	if err := writeReady(&buf, 53121); err != nil {
		t.Fatal(err)
	}

	var got struct {
		Event   string `json:"event"`
		Port    int    `json:"port"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if got.Event != "ready" || got.Port != 53121 || got.Version != version {
		t.Fatalf("got %+v", got)
	}
	if bytes.Count(buf.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("want exactly one line, got %q", buf.String())
	}
}
