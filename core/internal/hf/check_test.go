package hf

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/models"
)

// ggufBytes is a GGUF v3 header of a llama model with block_count and nextn_predict_layers, and one
// blk.N.attn_norm.weight tensor per block, padded to 32 bytes.
func ggufBytes(blockCount, nextn int, blocks ...int) []byte {
	le32 := func(b []byte, v uint32) []byte { return binary.LittleEndian.AppendUint32(b, v) }
	le64 := func(b []byte, v uint64) []byte { return binary.LittleEndian.AppendUint64(b, v) }
	str := func(b []byte, s string) []byte { return append(le64(b, uint64(len(s))), s...) }
	const typeUint32, typeString = 4, 8

	b := le32([]byte("GGUF"), 3)
	b = le64(b, uint64(len(blocks)))
	b = le64(b, 3)
	b = le32(str(b, "general.architecture"), typeString)
	b = str(b, "llama")
	b = le32(le32(str(b, "llama.block_count"), typeUint32), uint32(blockCount))
	b = le32(le32(str(b, "llama.nextn_predict_layers"), typeUint32), uint32(nextn))
	for i, n := range blocks {
		b = str(b, fmt.Sprintf("blk.%d.attn_norm.weight", n))
		b = le64(le32(b, 1), 1) // one dimension of 1
		b = le64(le32(b, 0), uint64(32*i))
	}
	return append(b, make([]byte, (32-len(b)%32)%32)...)
}

// allBlocks is 0 … n−1.
func allBlocks(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

const checkPath = "/o/m/resolve/" + testSHA + "/BF16/draft-MTP.BF16.gguf"

var checkFileRef = GroupFile{Name: "draft-MTP.BF16.gguf", Path: "BF16/draft-MTP.BF16.gguf"}

// servePartial answers data as 206, the way Hugging Face answers a Range request.
func servePartial(data []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(data)-1, len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data)
	}
}

func TestCheckDraftFileIsIncomplete(t *testing.T) {
	var log bytes.Buffer
	f := newFakeHF(t, map[string]http.HandlerFunc{checkPath: servePartial(ggufBytes(49, 1, 48))})
	c := f.client(t, Config{Logger: slog.New(slog.NewTextHandler(&log, nil))})
	got, err := c.Check(context.Background(), "o/m", testSHA, checkFileRef)
	if err != nil || got != models.IncompleteMessage(1, 49) {
		t.Fatalf("Check = %q, %v; want the incomplete text", got, err)
	}
	reqs := f.requests()
	if len(reqs) != 1 || reqs[0].Header.Get("Range") != "bytes=0-67108863" {
		t.Fatalf("requests = %d, Range %q", len(reqs), reqs[0].Header.Get("Range"))
	}
	for _, r := range reqs {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("sent Authorization %q, Cookie %q", r.Header.Get("Authorization"), r.Header.Get("Cookie"))
		}
	}
	line := log.String()
	if !strings.Contains(line, "msg=\"hf check\"") || !strings.Contains(line, "result=incomplete") ||
		!strings.Contains(line, "file=draft-MTP.BF16.gguf") || strings.Contains(line, "resolve") || strings.Contains(line, "BF16/") {
		t.Fatalf("log = %s", line)
	}
}

func TestCheckFullFileAnswered206(t *testing.T) {
	f := newFakeHF(t, map[string]http.HandlerFunc{checkPath: servePartial(ggufBytes(49, 1, allBlocks(49)...))})
	if got, err := f.client(t, Config{}).Check(context.Background(), "o/m", testSHA, checkFileRef); err != nil || got != "" {
		t.Fatalf("Check = %q, %v; want \"\"", got, err)
	}
}

func TestCheckFullFileAnswered200StopsAfterTheHeader(t *testing.T) {
	const padding = 64 << 20
	header := ggufBytes(49, 1, allBlocks(49)...)
	written := make(chan int, 1)
	f := newFakeHF(t, map[string]http.HandlerFunc{checkPath: func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		n, _ := w.Write(header)
		chunk := make([]byte, 64<<10)
		for n < len(header)+padding {
			m, err := w.Write(chunk)
			n += m
			if err != nil {
				break
			}
		}
		written <- n
	}})
	if got, err := f.client(t, Config{}).Check(context.Background(), "o/m", testSHA, checkFileRef); err != nil || got != "" {
		t.Fatalf("Check = %q, %v; want \"\"", got, err)
	}
	select {
	case n := <-written:
		if n >= len(header)+padding {
			t.Fatalf("the handler wrote all %d bytes; the body was read to the end", n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the handler never saw the connection closed")
	}
}

func TestCheckRedirects(t *testing.T) {
	t.Run("to the same host keeps Range", func(t *testing.T) {
		f := newFakeHF(t, map[string]http.HandlerFunc{
			checkPath:   func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/cdn/blob", http.StatusFound) },
			"/cdn/blob": servePartial(ggufBytes(49, 1, 48)),
		})
		got, err := f.client(t, Config{}).Check(context.Background(), "o/m", testSHA, checkFileRef)
		if err != nil || got == "" {
			t.Fatalf("Check = %q, %v; want the incomplete text", got, err)
		}
		reqs := f.requests()
		if len(reqs) != 2 || reqs[1].Header.Get("Range") != "bytes=0-67108863" || reqs[1].Header.Get("Cookie") != "" {
			t.Fatalf("requests = %d, redirected Range %q", len(reqs), reqs[len(reqs)-1].Header.Get("Range"))
		}
	})
	t.Run("to another host is a bad answer", func(t *testing.T) {
		other := newFakeHF(t, map[string]http.HandlerFunc{"/blob": servePartial(ggufBytes(49, 1, 48))})
		f := newFakeHF(t, map[string]http.HandlerFunc{
			checkPath: func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, other.srv.URL+"/blob", http.StatusFound)
			},
		})
		if _, err := f.client(t, Config{}).Check(context.Background(), "o/m", testSHA, checkFileRef); !errors.Is(err, ErrBadAnswer) {
			t.Fatalf("err = %v, want ErrBadAnswer", err)
		}
		if n := len(other.requests()); n != 0 {
			t.Fatalf("the other host got %d requests", n)
		}
	})
}

func TestCheckIsCachedOnlyWhenItSucceeds(t *testing.T) {
	t.Run("a second call makes no request", func(t *testing.T) {
		f := newFakeHF(t, map[string]http.HandlerFunc{checkPath: servePartial(ggufBytes(49, 1, 48))})
		c := f.client(t, Config{})
		for range 2 {
			if got, err := c.Check(context.Background(), "o/m", testSHA, checkFileRef); err != nil || got == "" {
				t.Fatalf("Check = %q, %v", got, err)
			}
		}
		if n := len(f.requests()); n != 1 {
			t.Fatalf("%d requests, want 1", n)
		}
	})
	t.Run("a 500 is unreachable and asked again", func(t *testing.T) {
		f := newFakeHF(t, map[string]http.HandlerFunc{checkPath: serveStatus(http.StatusInternalServerError)})
		c := f.client(t, Config{})
		for range 2 {
			if _, err := c.Check(context.Background(), "o/m", testSHA, checkFileRef); !errors.Is(err, ErrUnreachable) {
				t.Fatalf("err = %v, want ErrUnreachable", err)
			}
		}
		if n := len(f.requests()); n != 2 {
			t.Fatalf("%d requests, want 2", n)
		}
	})
}

func TestCheckBadAnswers(t *testing.T) {
	t.Run("a body that is not GGUF", func(t *testing.T) {
		f := newFakeHF(t, map[string]http.HandlerFunc{checkPath: servePartial([]byte("<html>not a model</html>"))})
		if _, err := f.client(t, Config{}).Check(context.Background(), "o/m", testSHA, checkFileRef); !errors.Is(err, ErrBadAnswer) {
			t.Fatalf("err = %v, want ErrBadAnswer", err)
		}
	})
	t.Run("a repo that is not owner/name sends nothing", func(t *testing.T) {
		f := newFakeHF(t, map[string]http.HandlerFunc{})
		if _, err := f.client(t, Config{}).Check(context.Background(), "../m", testSHA, checkFileRef); !errors.Is(err, ErrBadAnswer) {
			t.Fatalf("err = %v, want ErrBadAnswer", err)
		}
		if n := len(f.requests()); n != 0 {
			t.Fatalf("%d requests, want none", n)
		}
	})
}

// Search and Files never ask for a range: only Check's requests carry one.
func TestSearchAndFilesSendNoRange(t *testing.T) {
	routes := fakeRepo(gguf("m-Q4_K_M.gguf", 10))
	routes["/api/models"] = serveBody("[]")
	f := newFakeHF(t, routes)
	c := f.filesClient(t, t.TempDir())
	if _, err := c.Search(context.Background(), "qwen"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Files(context.Background(), "o", "m"); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.requests() {
		if r.Header.Get("Range") != "" {
			t.Errorf("%s carried Range %q", r.URL.Path, r.Header.Get("Range"))
		}
	}
}
