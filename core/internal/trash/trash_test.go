package trash

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMoveRemovesFolder(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the Recycle Bin exists only on Windows")
	}
	folder := filepath.Join(t.TempDir(), "model")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "a.gguf"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Move(folder); err != nil {
		t.Fatalf("Move: %v", err)
	}
	if _, err := os.Stat(folder); !os.IsNotExist(err) {
		t.Fatalf("folder still there: %v", err)
	}
}

func TestMoveRefusesRelativePath(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.Mkdir("model", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Move("model"); err == nil {
		t.Fatal("Move accepted a relative path")
	}
	if _, err := os.Stat(filepath.Join(dir, "model")); err != nil {
		t.Fatalf("folder touched: %v", err)
	}
}

func TestMoveMissingPath(t *testing.T) {
	if err := Move(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("Move of a missing path returned nil")
	}
}
