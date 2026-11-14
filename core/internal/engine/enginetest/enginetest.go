// Package enginetest is the contract every engine.Engine must pass.
package enginetest

import (
	"context"
	"net"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/engine"
)

type Fixture struct {
	New        func(t *testing.T) engine.Engine
	Ready      engine.Spec // a spec that becomes healthy
	NeverReady engine.Spec // a spec whose health never turns 200
}

var idPattern = regexp.MustCompile(`^[a-z]+(\.[a-z0-9]+)+$`)

// Run is one subtest per contract rule.
func Run(t *testing.T, f Fixture) {
	t.Run("describe", func(t *testing.T) {
		if id := f.New(t).Describe().ID; !idPattern.MatchString(id) {
			t.Fatalf("id %q is not lowercase and dot-separated", id)
		}
	})

	t.Run("ready", func(t *testing.T) {
		inst := start(t, f.New(t), f.Ready, 10*time.Second)
		if inst.State() != engine.StateReady {
			t.Fatalf("state = %s, want ready", inst.State())
		}
		resp, err := http.Get(inst.BaseURL())
		if err != nil {
			t.Fatalf("GET %s: %v", inst.BaseURL(), err)
		}
		resp.Body.Close()
	})

	t.Run("stop", func(t *testing.T) {
		inst := start(t, f.New(t), f.Ready, 10*time.Second)
		addr := strings.TrimPrefix(inst.BaseURL(), "http://")
		inst.Stop(5 * time.Second)
		if inst.State() != engine.StateStopped {
			t.Fatalf("state = %s, want stopped", inst.State())
		}
		select {
		case <-inst.Wait():
		default:
			t.Fatal("Wait is not closed after Stop")
		}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			t.Fatalf("port still taken after Stop: %v", err)
		}
		ln.Close()
		returned := make(chan struct{})
		go func() { inst.Stop(5 * time.Second); close(returned) }()
		select {
		case <-returned:
		case <-time.After(time.Second):
			t.Fatal("a second Stop did not return at once")
		}
	})

	t.Run("never ready", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		type result struct {
			inst engine.Instance
			err  error
		}
		done := make(chan result, 1)
		e := f.New(t)
		go func() {
			inst, err := e.Start(ctx, f.NeverReady)
			done <- result{inst, err}
		}()
		select {
		case r := <-done:
			if r.err == nil || r.inst != nil {
				t.Fatalf("Start = %v, %v; want an error and no instance", r.inst, r.err)
			}
		case <-time.After(8 * time.Second):
			t.Fatal("Start did not give up within 8s")
		}
	})
}

func start(t *testing.T, e engine.Engine, spec engine.Spec, timeout time.Duration) engine.Instance {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	inst, err := e.Start(ctx, spec)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { inst.Stop(5 * time.Second) })
	return inst
}
