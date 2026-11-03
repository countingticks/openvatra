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
		"nul in argument":        {Options: map[string]ModelOptions{"m": {Args: []string{"a\x00b"}}}},
		"reserved --port":        {Options: map[string]ModelOptions{"m": {Args: []string{"--port", "1"}}}},
		"reserved -m=":           {Options: map[string]ModelOptions{"m": {Args: []string{"-m=x.gguf"}}}},
		"reserved --mmproj":      {Options: map[string]ModelOptions{"m": {Args: []string{"--mmproj", "p.gguf"}}}},
		"reserved in sharedArgs": {SharedArgs: []string{"--host", "0.0.0.0"}},
		"negative model idle":    {Options: map[string]ModelOptions{"m": {IdleUnloadMinutes: ptr(-1)}}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := c.Validate(); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	ok := Config{
		SharedArgs: []string{"-fa", "on"},
		Options:    map[string]ModelOptions{"m": {Args: []string{"-c", "8192"}}},
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

func ptr[T any](v T) *T { return &v }

func TestPerModelOverrides(t *testing.T) {
	c := Config{
		IdleUnloadMinutes: 15,
		EmbeddingModel:    "embed",
		Options: map[string]ModelOptions{
			"own":   {IdleUnloadMinutes: ptr(60)},
			"never": {IdleUnloadMinutes: ptr(0), MMProj: ptr(false)},
			"empty": {},
		},
	}
	for id, want := range map[string]time.Duration{"own": time.Hour, "never": 0, "empty": 15 * time.Minute, "unknown": 15 * time.Minute, "embed": 0} {
		if got := c.IdleTimeout(id); got != want {
			t.Errorf("IdleTimeout(%q) = %v, want %v", id, got, want)
		}
	}
	for id, want := range map[string]bool{"never": false, "empty": true, "unknown": true} {
		if got := c.UseMMProj(id); got != want {
			t.Errorf("UseMMProj(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestEmbeddingModelOwnIdleSettingWins(t *testing.T) {
	c := Config{IdleUnloadMinutes: 15, EmbeddingModel: "embed", Options: map[string]ModelOptions{"embed": {IdleUnloadMinutes: ptr(5)}}}
	if got := c.IdleTimeout("embed"); got != 5*time.Minute {
		t.Errorf("IdleTimeout(embed) = %v, want 5m", got)
	}
}
