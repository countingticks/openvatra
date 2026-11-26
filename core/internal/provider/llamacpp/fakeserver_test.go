package llamacpp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/provider"
)

var (
	fakeBuild sync.Once
	fakePath  string
	fakeErr   error
)

// builtFake compiles core/testdata/fake-server once for the package's tests (go test skips testdata/).
func builtFake(t *testing.T) string {
	t.Helper()
	fakeBuild.Do(func() {
		dir, err := os.MkdirTemp("", "fake-server")
		if err != nil {
			fakeErr = err
			return
		}
		fakePath = filepath.Join(dir, "fake-server")
		if runtime.GOOS == "windows" {
			fakePath += ".exe"
		}
		if out, err := exec.Command("go", "build", "-o", fakePath, "../../../testdata/fake-server").CombinedOutput(); err != nil {
			fakeErr = fmt.Errorf("building fake server: %v\n%s", err, out)
		}
	})
	if fakeErr != nil {
		t.Fatal(fakeErr)
	}
	return fakePath
}

// startFake runs the fake llama-server with args on a free port and returns its base URL once /health says 200.
func startFake(t *testing.T, args ...string) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, builtFake(t), append([]string{"--port", fmt.Sprint(port)}, args...)...)
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		cmd.Wait()
	})
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if resp, err := http.Get(base + "/health"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return base
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the fake server did not become healthy")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// readFake posts a chat request to the fake and reads its answer the way core does.
func readFake(ctx context.Context, t *testing.T, base string, emit func(provider.Delta)) (*stream, error) {
	t.Helper()
	return readFakeBody(ctx, t, base, `{"messages":[]}`, emit)
}

// readFakeBody is readFake with its own request body.
func readFakeBody(ctx context.Context, t *testing.T, base, body string, emit func(provider.Delta)) (*stream, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	s := &stream{sent: time.Now(), emit: emit}
	return s, s.read(http.DefaultClient, req)
}

func TestFakeServerStreamsAnswers(t *testing.T) {
	t.Run("the reply comes word by word with its usage", func(t *testing.T) {
		base := startFake(t, "--reply", "a b c")
		var got []string
		s, err := readFake(context.Background(), t, base, func(d provider.Delta) {
			got = append(got, fmt.Sprintf("%d:%s", d.Kind, d.Text))
		})
		if err != nil {
			t.Fatal(err)
		}
		text := fmt.Sprint(provider.PartText)
		if want := []string{text + ":a ", text + ":b ", text + ":c"}; !slices.Equal(got, want) {
			t.Fatalf("deltas %q, want %q", got, want)
		}
		if s.usage == nil || s.usage.CompletionTokens != 3 {
			t.Fatalf("usage %+v", s.usage)
		}
	})

	t.Run("reasoning comes before the reply", func(t *testing.T) {
		base := startFake(t, "--reasoning", "x y", "--reply", "z")
		var kinds []provider.PartKind
		if _, err := readFake(context.Background(), t, base, func(d provider.Delta) { kinds = append(kinds, d.Kind) }); err != nil {
			t.Fatal(err)
		}
		want := []provider.PartKind{provider.PartReasoning, provider.PartReasoning, provider.PartText}
		if !slices.Equal(kinds, want) {
			t.Fatalf("kinds %v, want %v", kinds, want)
		}
	})

	t.Run("max_tokens caps the reply's words, not the reasoning's", func(t *testing.T) {
		base := startFake(t, "--reasoning", "x y z", "--reply", "a b c d")
		var reasoning, text []string
		_, err := readFakeBody(context.Background(), t, base, `{"messages":[],"max_tokens":2}`, func(d provider.Delta) {
			if d.Kind == provider.PartText {
				text = append(text, d.Text)
			} else {
				reasoning = append(reasoning, d.Text)
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(text, []string{"a ", "b "}) || len(reasoning) != 3 {
			t.Fatalf("text %q, reasoning %q", text, reasoning)
		}
	})

	t.Run("the reply keeps its newlines and spaces", func(t *testing.T) {
		reply := "  # T\n\n- a\n- b\n\n```go\nx := 1\n```\n"
		base := startFake(t, "--reply", reply)
		var got []string
		s, err := readFake(context.Background(), t, base, func(d provider.Delta) { got = append(got, d.Text) })
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(got, "") != reply {
			t.Fatalf("joined %q, want %q", strings.Join(got, ""), reply)
		}
		if s.usage == nil || s.usage.CompletionTokens != len(got) {
			t.Fatalf("usage %+v for %d deltas", s.usage, len(got))
		}
	})

	t.Run("a reply file is streamed as written", func(t *testing.T) {
		text := "First paragraph,\n  indented line.\n\nSecond paragraph.\n"
		path := filepath.Join(t.TempDir(), "reply.md")
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		base := startFake(t, "--reply-file", path, "--reply", "other")
		var got []string
		if _, err := readFake(context.Background(), t, base, func(d provider.Delta) { got = append(got, d.Text) }); err != nil {
			t.Fatal(err)
		}
		if strings.Join(got, "") != text {
			t.Fatalf("joined %q, want %q", strings.Join(got, ""), text)
		}
	})

	t.Run("an unreadable reply file exits with 2", func(t *testing.T) {
		cmd := exec.Command(builtFake(t), "--reply-file", filepath.Join(t.TempDir(), "missing.md"))
		var stderr strings.Builder
		cmd.Stderr = &stderr
		err := cmd.Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 2 {
			t.Fatalf("err %v", err)
		}
		if !strings.Contains(stderr.String(), "reading --reply-file") {
			t.Fatalf("stderr %q", stderr.String())
		}
	})

	t.Run("a body that is not JSON answers 400", func(t *testing.T) {
		base := startFake(t)
		resp, err := http.Post(base+"/v1/chat/completions", "application/json", strings.NewReader("not json"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status %d", resp.StatusCode)
		}
	})

	t.Run("cancelling the request ends the read within a second", func(t *testing.T) {
		base := startFake(t, "--token-delay", "200ms", "--reply", "a b c d e f g h i j")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := readFake(ctx, t, base, func(provider.Delta) { cancel() })
			done <- err
		}()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("read did not return after the context was cancelled")
		}
	})
}

// burnWorkers asks the fake how many burn workers are spinning right now.
func burnWorkers(t *testing.T, base string) int {
	t.Helper()
	resp, err := http.Get(base + "/debug/burn")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Workers int `json:"workers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Workers
}

// waitWorkers polls until the worker count is want, or fails after 3 s.
func waitWorkers(t *testing.T, base string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := burnWorkers(t, base)
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("workers %d, want %d", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestFakeServerBurnsCPU(t *testing.T) {
	streamInBackground := func(base string) (done chan struct{}) {
		done = make(chan struct{})
		go func() {
			defer close(done)
			readFake(context.Background(), t, base, func(provider.Delta) {})
		}()
		return done
	}

	t.Run("-burn-cpu 2 runs two workers while it streams and none after", func(t *testing.T) {
		base := startFake(t, "--burn-cpu", "2", "--token-delay", "100ms", "--reply", "a b c d e f")
		done := streamInBackground(base)
		waitWorkers(t, base, 2)
		<-done
		waitWorkers(t, base, 0)
	})

	t.Run("-1 runs one worker per logical CPU", func(t *testing.T) {
		base := startFake(t, "--burn-cpu", "-1", "--token-delay", "100ms", "--reply", "a b c d e f")
		done := streamInBackground(base)
		waitWorkers(t, base, runtime.NumCPU())
		<-done
	})

	t.Run("0 never burns", func(t *testing.T) {
		base := startFake(t, "--burn-cpu", "0", "--token-delay", "50ms", "--reply", "a b c d")
		first := make(chan struct{}, 1)
		done := make(chan struct{})
		go func() {
			defer close(done)
			readFake(context.Background(), t, base, func(provider.Delta) {
				select {
				case first <- struct{}{}:
				default:
				}
			})
		}()
		<-first
		if got := burnWorkers(t, base); got != 0 {
			t.Fatalf("workers %d mid-stream", got)
		}
		<-done
		if got := burnWorkers(t, base); got != 0 {
			t.Fatalf("workers %d after", got)
		}
	})

	t.Run("a cancelled stream stops the burn", func(t *testing.T) {
		base := startFake(t, "--burn-cpu", "2", "--token-delay", "100ms", "--reply", "a b c d e f g h")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		readFake(ctx, t, base, func(provider.Delta) { cancel() })
		waitWorkers(t, base, 0)
	})

	t.Run("FAKE_SERVER_BURN_CPU sets the default", func(t *testing.T) {
		t.Setenv("FAKE_SERVER_BURN_CPU", "1")
		base := startFake(t, "--token-delay", "100ms", "--reply", "a b c d e f")
		done := streamInBackground(base)
		waitWorkers(t, base, 1)
		<-done
	})

	t.Run("a bad value exits with 2", func(t *testing.T) {
		err := exec.Command(builtFake(t), "--burn-cpu", "-2").Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 2 {
			t.Fatalf("err %v", err)
		}
	})
}
