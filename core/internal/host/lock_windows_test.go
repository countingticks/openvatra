//go:build windows

package host

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const helperEnv = "OPENVATRA_HOST_HELPER"

// TestLockHelper is not a real test: TestLockGoneAfterHolderKilled re-runs this
// binary to hold the lock in another process.
func TestLockHelper(t *testing.T) {
	if os.Getenv(helperEnv) != "lock" {
		t.Skip("only runs as a child of TestLockGoneAfterHolderKilled")
	}
	if _, err := Lock(os.Getenv("OPENVATRA_HOST_DIR")); err != nil {
		fmt.Println("lock error:", err)
		os.Exit(1)
	}
	fmt.Println("locked")
	time.Sleep(time.Minute) // the parent kills us long before this
}

func TestSecondLockFailsUntilFirstCloses(t *testing.T) {
	dir := t.TempDir()
	first, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Lock = %v, want ErrLocked", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("second Close = %v, want nil", err)
	}
	again, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock after Close = %v", err)
	}
	again.Close()
}

func TestLockCreatesMissingFolder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "data")
	l, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if _, err := os.Stat(filepath.Join(dir, "core.lock")); err != nil {
		t.Fatalf("core.lock: %v", err)
	}
}

func TestLockGoneAfterHolderKilled(t *testing.T) {
	dir := t.TempDir()
	helper := exec.Command(os.Args[0], "-test.run=^TestLockHelper$")
	helper.Env = append(os.Environ(), helperEnv+"=lock", "OPENVATRA_HOST_DIR="+dir)
	out, err := helper.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer helper.Process.Kill()

	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "locked" {
		t.Fatalf("helper said %q (%v)", line, err)
	}
	if _, err := Lock(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("Lock while helper holds it = %v, want ErrLocked", err)
	}
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	helper.Wait()
	l, err := Lock(dir)
	if err != nil {
		t.Fatalf("Lock after holder was killed = %v", err)
	}
	l.Close()
}
