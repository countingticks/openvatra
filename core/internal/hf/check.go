package hf

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/models"
)

// checkRange asks for no more than models reads of a header (64 MiB).
var checkRange = fmt.Sprintf("bytes=0-%d", 64<<20-1)

// Check reads the header of f in repo (owner/name) at revision with one ranged GET and applies the completeness
// rule: models.IncompleteMessage's text when the file is incomplete, "" when it is complete or not judged.
// Errors wrap ErrUnreachable or ErrBadAnswer.
func (c *Client) Check(ctx context.Context, repo, revision string, f GroupFile) (string, error) {
	start := time.Now()
	file := path.Base(f.Path)
	key := "check:" + repo + "@" + revision + "/" + f.Path
	if v, ok := c.cache.get(key); ok {
		return v.(string), nil
	}
	text, err := c.checkFile(ctx, repo, revision, f.Path)
	if err != nil {
		c.log.Warn("hf check failed", "repo", repo, "file", file, "reason", reason(err))
		return "", err
	}
	c.cache.put(key, text)
	result := "ok"
	if text != "" {
		result = "incomplete"
	}
	c.log.Info("hf check", "repo", repo, "file", file, "ms", time.Since(start).Milliseconds(), "result", result)
	return text, nil
}

// checkFile GETs the start of the file and runs models.CheckHeader on it. The body is closed once the tensor table
// is parsed, so with a 200 the rest of the file is never read.
func (c *Client) checkFile(ctx context.Context, repo, revision, filePath string) (string, error) {
	u, ok := c.resolveURL(repo, revision, filePath)
	if !ok {
		return "", ErrBadAnswer
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", ErrBadAnswer
	}
	c.setHeaders(req)
	req.Header.Set("Range", checkRange)
	resp, err := c.checkHTTP.Do(req)
	if err != nil {
		if errors.Is(err, errRedirect) {
			return "", ErrBadAnswer
		}
		return "", ErrUnreachable
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent:
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return "", &statusError{code: resp.StatusCode, err: ErrUnreachable}
	default:
		return "", &statusError{code: resp.StatusCode, err: ErrBadAnswer}
	}
	body := &readTracker{r: resp.Body}
	text, err := models.CheckHeader(body)
	switch {
	case err != nil && body.err != nil:
		return "", ErrUnreachable
	case err != nil:
		return "", ErrBadAnswer
	}
	return text, nil
}

// resolveURL is <base>/<owner>/<name>/resolve/<revision>/<path> with every segment escaped; false for a repo that
// is not owner/name or a path that steps out of the repo.
func (c *Client) resolveURL(repo, revision, filePath string) (*url.URL, bool) {
	owner, name, ok := splitID(repo)
	if !ok || revision == "" || filePath == "" {
		return nil, false
	}
	segs := append([]string{owner, name, "resolve", revision}, strings.Split(filePath, "/")...)
	for i, s := range segs {
		if s == "" || s == "." || s == ".." {
			return nil, false
		}
		segs[i] = url.PathEscape(s)
	}
	raw := "/" + strings.Join(segs, "/")
	unescaped, err := url.PathUnescape(raw)
	if err != nil {
		return nil, false
	}
	u := *c.base
	u.Path, u.RawPath, u.RawQuery = unescaped, raw, ""
	return &u, true
}

// readTracker keeps the first read error other than EOF, which tells a dropped connection from a bad header.
type readTracker struct {
	r   io.Reader
	err error
}

func (t *readTracker) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && err != io.EOF && t.err == nil {
		t.err = err
	}
	return n, err
}
