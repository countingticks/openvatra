package llamacpp

import (
	"context"
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
		if !slices.Equal(text, []string{"a ", "b"}) || len(reasoning) != 3 {
			t.Fatalf("text %q, reasoning %q", text, reasoning)
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
