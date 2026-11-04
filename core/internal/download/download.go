// Package download fetches one file over HTTPS into a ".part" file, resumes it after an interruption, checks its
// SHA-256 and only then gives it its real name. It knows nothing about queues or the catalog (that is the caller).
package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	// ErrNotAllowed: the URL, or a redirect on the way, points outside the allowed hosts or isn't HTTPS.
	ErrNotAllowed = errors.New("download: host or scheme not allowed")
	// ErrDamaged: all bytes arrived but the SHA-256 differs. The partial file is already deleted.
	ErrDamaged = errors.New("download: file is damaged")
	// ErrPaused: the network kept failing after every retry. The .part file is kept so Resume can continue it.
	ErrPaused = errors.New("download: paused, no connection")
)

// permanent marks errors that retrying cannot fix (a 404, say).
type permanent struct{ error }

func (p permanent) Unwrap() error { return p.error }

// Request describes one file. Size and SHA256 come from the catalog (Hugging Face's listing at the pinned revision).
type Request struct {
	URL    string
	Dest   string // final path; the data is written to Dest + ".part"
	Size   int64
	SHA256 string // lowercase hex
	// AllowHost replaces the downloader's host list for this file (the engine comes from GitHub, not Hugging Face).
	AllowHost func(host string) bool
}

// Progress is reported while bytes arrive. Done includes bytes already in the .part file when resuming.
type Progress struct{ Done, Total int64 }

// Downloader holds the settings tests need to change; the zero value plus New() is what production uses.
type Downloader struct {
	// Client is used for requests. Its redirect policy is replaced by the host check.
	Client *http.Client
	// AllowHost decides which hosts may be contacted, including after redirects.
	AllowHost func(host string) bool
	// Backoff is the wait before each retry; its length is the number of retries.
	Backoff []time.Duration
	// AllowLocalHTTP lets plain http through for 127.0.0.1 and localhost. Only the test catalog turns it on.
	AllowLocalHTTP bool
}

// New returns a downloader for Hugging Face with the retry waits from the spec (2, 8, 30 s).
func New() *Downloader {
	return &Downloader{
		Client:    &http.Client{},
		AllowHost: HuggingFaceHost,
		Backoff:   []time.Duration{2 * time.Second, 8 * time.Second, 30 * time.Second},
	}
}

// HuggingFaceHost allows huggingface.co and its CDN domain hf.co (cdn-lfs.hf.co, cas-bridge.xethub.hf.co, ...).
// The dot before "hf.co" matters: "evilhf.co" must not pass.
func HuggingFaceHost(host string) bool {
	return host == "huggingface.co" || host == "hf.co" || strings.HasSuffix(host, ".hf.co")
}

// GitHubReleaseHost allows github.com and the two hosts its release downloads redirect to. Exact names, not a
// suffix: anyone can publish under other *.githubusercontent.com hosts.
func GitHubReleaseHost(host string) bool {
	return host == "github.com" || host == "objects.githubusercontent.com" || host == "release-assets.githubusercontent.com"
}

// Fetch downloads req. It returns nil only when Dest exists with the right checksum.
// On context cancel it returns the context's error and leaves the .part file; deleting it is the caller's choice.
func (d *Downloader) Fetch(ctx context.Context, req Request, onProgress func(Progress)) error {
	if err := d.checkURL(req.URL, req.AllowHost); err != nil {
		return err
	}
	var err error
	for attempt := 0; ; attempt++ {
		err = d.attempt(ctx, req, onProgress)
		if err == nil || ctx.Err() != nil {
			break
		}
		var perm permanent
		if errors.As(err, &perm) || errors.Is(err, ErrDamaged) {
			break
		}
		if attempt >= len(d.Backoff) {
			return fmt.Errorf("%w: %v", ErrPaused, err)
		}
		select {
		case <-time.After(d.Backoff[attempt]):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// checkURL applies allow (the request's own list) or, when that is nil, the downloader's.
func (d *Downloader) checkURL(raw string, allow func(string) bool) error {
	if allow == nil {
		allow = d.AllowHost
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrNotAllowed, raw)
	}
	local := d.AllowLocalHTTP && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")
	if (u.Scheme != "https" && !local) || !allow(u.Hostname()) {
		return fmt.Errorf("%w: %s", ErrNotAllowed, raw)
	}
	return nil
}

// attempt makes one pass: resume from whatever is in the .part file, stream the rest, verify, rename.
func (d *Downloader) attempt(ctx context.Context, req Request, onProgress func(Progress)) error {
	part := req.Dest + ".part"
	h := sha256.New()

	offset, err := hashExisting(part, req.Size, h)
	if err != nil {
		return permanent{err}
	}

	if offset < req.Size {
		offset, err = d.stream(ctx, req, part, offset, h, onProgress)
		if err != nil {
			return err
		}
	}
	if offset != req.Size {
		// Connection ended early: keep the part, the next attempt resumes it.
		return fmt.Errorf("download: got %d of %d bytes", offset, req.Size)
	}

	if hex.EncodeToString(h.Sum(nil)) != req.SHA256 {
		_ = os.Remove(part)
		return ErrDamaged
	}
	if err := os.Rename(part, req.Dest); err != nil {
		return permanent{err}
	}
	return nil
}

// hashExisting feeds the current .part file into h and returns its size. A part that is bigger than expected
// can't be a prefix of the right file, so it is deleted and we start from zero.
func hashExisting(part string, want int64, h io.Writer) (int64, error) {
	f, err := os.Open(part)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if info.Size() > want {
		f.Close()
		return 0, os.Remove(part)
	}
	n, err := io.Copy(h, f)
	return n, err
}

// stream requests the bytes from offset on and appends them to the part file, hashing as they pass.
// It returns the new size of the part file.
func (d *Downloader) stream(ctx context.Context, req Request, part string, offset int64, h hash.Hash, onProgress func(Progress)) (int64, error) {
	client := *d.Client // copy, so our redirect rule doesn't leak into a shared client
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		return d.checkURL(r.URL.String(), req.AllowHost)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, req.URL, nil)
	if err != nil {
		return offset, permanent{err}
	}
	if offset > 0 {
		httpReq.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		if errors.Is(err, ErrNotAllowed) {
			return offset, permanent{err}
		}
		return offset, err
	}
	defer resp.Body.Close()

	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	switch {
	case resp.StatusCode == http.StatusPartialContent:
		if start, ok := rangeStart(resp.Header.Get("Content-Range")); !ok || start != offset {
			return offset, permanent{fmt.Errorf("download: server sent the wrong range %q", resp.Header.Get("Content-Range"))}
		}
	case resp.StatusCode == http.StatusOK:
		// Either a first download, or the server ignored Range and is sending everything: start over.
		if offset > 0 {
			h.Reset()
		}
		offset = 0
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		_ = os.Remove(part) // our part doesn't match the file any more; the retry starts clean
		return 0, fmt.Errorf("download: range not satisfiable")
	case resp.StatusCode >= 500:
		return offset, fmt.Errorf("download: server answered %s", resp.Status)
	default:
		return offset, permanent{fmt.Errorf("download: server answered %s", resp.Status)}
	}

	f, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return offset, permanent{err}
	}
	defer f.Close()

	// Write to the file and the hash in one pass: no second read of a multi-GB file at the end.
	w := io.MultiWriter(f, h)
	buf := make([]byte, 256<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return offset, permanent{werr}
			}
			offset += int64(n)
			if onProgress != nil {
				onProgress(Progress{Done: offset, Total: req.Size})
			}
		}
		if rerr == io.EOF {
			return offset, nil
		}
		if rerr != nil {
			return offset, rerr
		}
	}
}

// rangeStart reads the first byte from "bytes 100-199/200".
func rangeStart(header string) (int64, bool) {
	rest, ok := strings.CutPrefix(header, "bytes ")
	if !ok {
		return 0, false
	}
	first, _, ok := strings.Cut(rest, "-")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(first, 10, 64)
	return n, err == nil
}
