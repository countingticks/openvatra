package hf

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	limitBurst     = 5
	limitPerSecond = 1
	limitMaxWait   = 2 * time.Second
	// defaultRetryAfter is the wait after a 429 whose Retry-After is missing or unreadable.
	defaultRetryAfter = 30 * time.Second
)

// bucket is the token bucket every Hugging Face API request takes from (decision 20): one token per request, a
// burst of 5, refilled at 1 per second. A waiting caller reserves its token, so waiters queue in turn.
type bucket struct {
	mu           sync.Mutex
	now          func() time.Time
	sleep        func(ctx context.Context, d time.Duration) error // nil = a timer that stops on ctx.Done()
	burst        float64
	perSecond    float64
	maxWait      time.Duration
	tokens       float64
	last         time.Time // when tokens was last refilled
	blockedUntil time.Time // Hugging Face's Retry-After
}

func newBucket(now func() time.Time) *bucket {
	return &bucket{now: now, burst: limitBurst, perSecond: limitPerSecond, maxWait: limitMaxWait, tokens: limitBurst, last: now()}
}

// take returns nil once the caller may send one request; *RateLimitedError or ctx.Err() otherwise.
func (b *bucket) take(ctx context.Context) error {
	b.mu.Lock()
	now := b.now()
	if now.Before(b.blockedUntil) {
		wait := b.blockedUntil.Sub(now)
		b.mu.Unlock()
		return &RateLimitedError{Wait: wait}
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(b.burst, b.tokens+elapsed*b.perSecond)
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		b.mu.Unlock()
		return nil
	}
	wait := time.Duration((1 - b.tokens) / b.perSecond * float64(time.Second))
	if wait > b.maxWait {
		b.mu.Unlock()
		return &RateLimitedError{Wait: wait}
	}
	b.tokens--
	sleep := b.sleep
	b.mu.Unlock()
	if sleep == nil {
		sleep = sleepCtx
	}
	return sleep(ctx, wait)
}

// block records Hugging Face's 429: no request until now+d; the later of two blocks wins.
func (b *bucket) block(d time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if until := b.now().Add(d); until.After(b.blockedUntil) {
		b.blockedUntil = until
	}
}

// sleepCtx waits d, or returns ctx's error when it ends first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// retryAfter reads a Retry-After value (decision 21): whole seconds or an HTTP date; 30 s when it is "", unreadable
// or not in the future.
func retryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if n, err := strconv.Atoi(v); err == nil {
		if n > 0 {
			// Capped at a day so a huge value cannot overflow into a negative wait.
			return time.Duration(min(n, 86400)) * time.Second
		}
		return defaultRetryAfter
	}
	if t, err := http.ParseTime(v); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return defaultRetryAfter
}
