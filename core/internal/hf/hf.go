// Package hf asks Hugging Face, only when the user asks, for GGUF repos and the files of one repo.
// It sends no token, no cookie and no header that says who the user is, and it never logs the search text.
package hf

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/countingticks/openvatra/core/internal/download"
	"github.com/countingticks/openvatra/core/internal/hw"
	"github.com/countingticks/openvatra/core/internal/models"
)

const (
	defaultBase    = "https://huggingface.co"
	defaultTimeout = 15 * time.Second
	maxBody        = 8 << 20
	maxRedirects   = 5
)

// Config is what a Client needs. Hardware and ModelsDir are read on every call.
type Config struct {
	BaseURL   string // "" = https://huggingface.co; otherwise http://127.0.0.1:<port> or http://localhost:<port> only
	Version   string // core's version, for the User-Agent "OpenVatra/<version>"
	Hardware  func() hw.Report
	ModelsDir func() string
	DiskFree  func(dir string) (uint64, error) // nil = hw.DiskFree
	Logger    *slog.Logger                     // nil = discard
	Now       func() time.Time                 // nil = time.Now; the cache's clock
	Timeout   time.Duration                    // 0 = 15 s, per request
}

// Client talks to Hugging Face. It is safe for use by several goroutines.
type Client struct {
	base      *url.URL
	local     bool // base is a loopback test server
	userAgent string
	hardware  func() hw.Report
	modelsDir func() string
	diskFree  func(dir string) (uint64, error)
	log       *slog.Logger
	now       func() time.Time
	http      *http.Client
	checkHTTP *http.Client // Check's: a large vocabulary makes a header several MB, so it gets twice the time
	cache     *cache
}

var (
	ErrBadBase     = errors.New("hf: the base URL must be a loopback http address")
	ErrBadQuery    = errors.New("the search must be 2 to 100 characters")
	ErrUnreachable = errors.New("Hugging Face couldn't be reached")
	ErrBadAnswer   = errors.New("Hugging Face sent an answer core couldn't read")
)

// errRedirect marks a redirect checkRedirect refused, so it reads as a bad answer and not as an unreachable host.
var errRedirect = errors.New("hf: redirect refused")

// New checks BaseURL and builds the HTTP client; ErrBadBase when BaseURL is set but not a loopback http address.
func New(cfg Config) (*Client, error) {
	raw, local := defaultBase, false
	if cfg.BaseURL != "" {
		if !localBase(cfg.BaseURL) {
			return nil, ErrBadBase
		}
		raw, local = cfg.BaseURL, true
	}
	base, err := url.Parse(raw)
	if err != nil {
		return nil, ErrBadBase
	}
	c := &Client{
		base:      base,
		local:     local,
		userAgent: "OpenVatra/" + cfg.Version,
		hardware:  cfg.Hardware,
		modelsDir: cfg.ModelsDir,
		diskFree:  cfg.DiskFree,
		log:       cfg.Logger,
		now:       cfg.Now,
	}
	if c.hardware == nil {
		c.hardware = func() hw.Report { return hw.Report{} }
	}
	if c.modelsDir == nil {
		c.modelsDir = func() string { return "" }
	}
	if c.diskFree == nil {
		c.diskFree = hw.DiskFree
	}
	if c.log == nil {
		c.log = slog.New(slog.DiscardHandler)
	}
	if c.now == nil {
		c.now = time.Now
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	// No cookie jar: nothing a server sets is ever sent back.
	c.http = &http.Client{Timeout: timeout, CheckRedirect: c.checkRedirect}
	c.checkHTTP = &http.Client{Timeout: 2 * timeout, CheckRedirect: c.checkRedirect}
	c.cache = newCache(c.now)
	return c, nil
}

// localBase accepts http://127.0.0.1:<port> or http://localhost:<port> and nothing else (catalog's rule).
func localBase(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost") &&
		u.Port() != "" && u.Path == "" && u.User == nil && u.RawQuery == ""
}

// checkRedirect follows Hugging Face's own hosts over https (or, in tests, the same loopback server) and nothing
// else. The headers are set afresh, so nothing the standard client would copy rides along; only Check's Range is
// carried over from the first request.
func (c *Client) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > maxRedirects {
		return errRedirect
	}
	u := req.URL
	allowed := u.Scheme == "https" && download.HuggingFaceHost(u.Hostname()) && (u.Port() == "" || u.Port() == "443")
	if c.local {
		allowed = u.Scheme == c.base.Scheme && u.Host == c.base.Host
	}
	if !allowed {
		return errRedirect
	}
	c.setHeaders(req)
	if r := via[0].Header.Get("Range"); r != "" {
		req.Header.Set("Range", r)
	}
	return nil
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header = http.Header{}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
}

// statusError is a non-200 answer; code lets a caller treat a status its own way (Files: 401 and 404).
type statusError struct {
	code int
	err  error
}

func (e *statusError) Error() string { return fmt.Sprintf("%v (status %d)", e.err, e.code) }
func (e *statusError) Unwrap() error { return e.err }

// fetch GETs u and returns its body (at most 8 MiB) and headers. Errors wrap ErrUnreachable or ErrBadAnswer.
func (c *Client) fetch(ctx context.Context, u *url.URL) ([]byte, http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil, ErrBadAnswer
	}
	c.setHeaders(req)
	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(err, errRedirect) {
			return nil, nil, ErrBadAnswer
		}
		return nil, nil, ErrUnreachable
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return nil, nil, &statusError{code: resp.StatusCode, err: ErrUnreachable}
	default:
		return nil, nil, &statusError{code: resp.StatusCode, err: ErrBadAnswer}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, nil, ErrUnreachable
	}
	if len(body) > maxBody {
		return nil, nil, ErrBadAnswer
	}
	return body, resp.Header, nil
}

// endpoint is base + path with query; path segments are escaped by the caller.
func (c *Client) endpoint(path string, query url.Values) *url.URL {
	u := *c.base
	u.Path = path
	u.RawQuery = query.Encode()
	return &u
}

var (
	segment = regexp.MustCompile(`^[\w.-]+$`)
	moeRe   = regexp.MustCompile(`(?i)\bA\d+(\.\d+)?B\b|moe`)
)

// safeSegment is an owner or a repo name: letters, digits, _ . - and never a path step.
func safeSegment(s string) bool {
	return segment.MatchString(s) && s != "." && s != ".." && !strings.Contains(s, "..")
}

// splitID splits "owner/name"; false unless both halves are safe.
func splitID(id string) (owner, name string, ok bool) {
	owner, name, found := strings.Cut(id, "/")
	if !found || !safeSegment(owner) || !safeSegment(name) {
		return "", "", false
	}
	return owner, name, true
}

// tagsFor is our tags for a repo, in order: Code, Vision, MoE, Embeddings. Never nil.
func tagsFor(name string, hfTags []string, pipeline string, vision bool) []string {
	tags := []string{}
	if models.IsCode(name) {
		tags = append(tags, "Code")
	}
	if vision {
		tags = append(tags, "Vision")
	}
	if moeRe.MatchString(name) || slices.ContainsFunc(hfTags, func(t string) bool { return strings.EqualFold(t, "moe") }) {
		tags = append(tags, "MoE")
	}
	if pipeline == "feature-extraction" || pipeline == "sentence-similarity" {
		tags = append(tags, "Embeddings")
	}
	return tags
}
