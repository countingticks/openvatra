package logs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRotatorKeepsThreeFilesAndDropsTheOldest(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	// Each write is 8 bytes, so every second write rotates.
	for _, s := range []string{"aaaaaaa\n", "bbbbbbb\n", "ccccccc\n", "ddddddd\n", "eeeeeee\n", "fffffff\n", "ggggggg\n"} {
		if _, err := r.Write([]byte(s)); err != nil {
			t.Fatal(err)
		}
	}
	if got := read(t, filepath.Join(dir, "core.log")); got != "ggggggg\n" {
		t.Errorf("core.log = %q", got)
	}
	if got := read(t, filepath.Join(dir, "core.1.log")); got != "fffffff\n" {
		t.Errorf("core.1.log = %q", got)
	}
	if got := read(t, filepath.Join(dir, "core.2.log")); got != "eeeeeee\n" {
		t.Errorf("core.2.log = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "core.3.log")); !os.IsNotExist(err) {
		t.Errorf("core.3.log should not exist, err = %v", err)
	}
}

func TestRotatorAppendsToAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	for _, s := range []string{"one\n", "two\n"} {
		r, err := NewRotator(dir, 1024)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = r.Write([]byte(s))
		_ = r.Close()
	}
	if got := read(t, filepath.Join(dir, "core.log")); got != "one\ntwo\n" {
		t.Errorf("core.log = %q", got)
	}
}

func TestPrefixedHoldsPartialLinesUntilTheirNewline(t *testing.T) {
	var sb strings.Builder
	w := Prefixed(&sb, "qwen")
	_, _ = w.Write([]byte("hello wor"))
	if sb.Len() != 0 {
		t.Fatalf("partial line was written: %q", sb.String())
	}
	_, _ = w.Write([]byte("ld\nsecond\nthi"))
	_, _ = w.Write([]byte("rd\n"))
	want := "[qwen] hello world\n[qwen] second\n[qwen] third\n"
	if sb.String() != want {
		t.Errorf("got %q, want %q", sb.String(), want)
	}
}

func TestSetupWithoutADirectoryDiscards(t *testing.T) {
	logger, w, c, err := Setup("")
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("nothing happens")
	_, _ = w.Write([]byte("x"))
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
}
