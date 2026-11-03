package config

import "testing"

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
	cases := map[string]ModelOptions{
		"negative context":    {ContextSize: intp(-1)},
		"negative gpu layers": {GPULayers: intp(-1)},
		"nul in argument":     {ExtraArgs: []string{"a\x00b"}},
		"reserved --port":     {ExtraArgs: []string{"--port", "1"}},
		"reserved -m=":        {ExtraArgs: []string{"-m=x.gguf"}},
	}
	for name, o := range cases {
		t.Run(name, func(t *testing.T) {
			if err := (Config{Options: map[string]ModelOptions{"m": o}}).Validate(); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	ok := Config{Options: map[string]ModelOptions{"m": {ContextSize: intp(8192), GPULayers: intp(0), ExtraArgs: []string{"--flash-attn", "on"}}}}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
}

func intp(n int) *int { return &n }
