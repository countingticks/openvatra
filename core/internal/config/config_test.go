package config

import (
	"testing"
	"time"
)

func TestStoreStartsEmptyAndKeepsLastValidConfig(t *testing.T) {
	s := NewStore()
	if got := s.Get(); got.ModelsDir != "" || got.IdleUnloadMinutes != 0 {
		t.Fatalf("new store = %+v, want zero", got)
	}
	if err := s.Set(Config{ModelsDir: `D:\models`, IdleUnloadMinutes: 15}); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(Config{IdleUnloadMinutes: -1}); err == nil {
		t.Fatal("negative idle minutes accepted")
	}
	if got := s.Get().ModelsDir; got != `D:\models` {
		t.Fatalf("a rejected config changed the store: ModelsDir = %q", got)
	}
}

func TestValidateOptions(t *testing.T) {
	cases := map[string]Config{
		"nul in argument":   {Options: map[string]ModelOptions{"m": {Args: []string{"a\x00b"}}}},
		"reserved --port":   {Options: map[string]ModelOptions{"m": {Args: []string{"--port", "1"}}}},
		"reserved -m=":      {Options: map[string]ModelOptions{"m": {Args: []string{"-m=x.gguf"}}}},
		"reserved --mmproj": {Options: map[string]ModelOptions{"m": {Args: []string{"--mmproj", "p.gguf"}}}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := c.Validate(); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	ok := Config{
		Options: map[string]ModelOptions{"m": {Args: []string{"-c", "8192", "--no-mmproj"}}},
	}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
}

func TestStoreCallsOnChangeOnlyForAcceptedConfigs(t *testing.T) {
	s := NewStore()
	calls := 0
	s.OnChange(func() { calls++ })

	if err := s.Set(Config{ModelsDir: "D:/Models"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(Config{IdleUnloadMinutes: -1}); err == nil {
		t.Fatal("a negative idle time was accepted")
	}

	if calls != 1 {
		t.Fatalf("onChange called %d times, want 1", calls)
	}
}

func TestIdleTimeout(t *testing.T) {
	if got := (Config{IdleUnloadMinutes: 15}).IdleTimeout(); got != 15*time.Minute {
		t.Errorf("IdleTimeout = %v, want 15m", got)
	}
	if got := (Config{}).IdleTimeout(); got != 0 {
		t.Errorf("with no global time IdleTimeout = %v, want never", got)
	}
}

func TestUseMMProj(t *testing.T) {
	c := Config{Options: map[string]ModelOptions{
		"off": {Args: []string{"-c", "4096", "--no-mmproj"}},
		"on":  {Args: []string{"-c", "4096"}},
	}}
	for id, want := range map[string]bool{"off": false, "on": true, "unknown": true} {
		if got := c.UseMMProj(id); got != want {
			t.Errorf("UseMMProj(%q) = %v, want %v", id, got, want)
		}
	}
}
