package llamacpp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/provider"
	"github.com/countingticks/openvatra/core/internal/provider/providertest"
)

func TestProviderContract(t *testing.T) {
	const loadedID = "qwen"
	providertest.Run(t, providertest.Fixture{
		New: func(t *testing.T, script providertest.Script) provider.Provider {
			up := &upstream{handler: func(_ int, w http.ResponseWriter, r *http.Request) { play(script, w, r) }}
			url := up.start(t)
			p := newServerProvider(&eventLog{}, func(string) string { return url })
			p.cfg.Plan = func(id string, _ bool) (engine.Spec, error) {
				if id != loadedID {
					return engine.Spec{}, provider.ErrUnknownModel
				}
				return engine.Spec{Model: id}, nil
			}
			return p
		},
		Loaded:  loadedID,
		Unknown: "gone",
	})
}

// play answers one request the way llama-server would for script.
func play(script providertest.Script, w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/tokenize" {
		fmt.Fprintf(w, `{"tokens":%s}`, mustJSON(make([]int, script.CountTokens)))
		return
	}
	var lines []string
	for _, s := range script.Text {
		lines = append(lines, fmt.Sprintf(`{"choices":[{"delta":{"content":%s}}]}`, mustJSON(s)))
	}
	if script.Hang {
		sse(w, lines...)
		<-r.Context().Done()
		if script.Ended != nil {
			script.Ended()
		}
		return
	}
	if c := script.ToolCall; c != nil {
		args := string(c.Arguments)
		half := len(args) / 2
		lines = append(lines,
			fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":%s,"type":"function","function":{"name":%s,"arguments":""}}]}}]}`,
				mustJSON(c.ID), mustJSON(c.Name)),
			fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":%s}}]}}]}`, mustJSON(args[:half])),
			fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":%s}}]},"finish_reason":"tool_calls"}]}`,
				mustJSON(args[half:])))
	} else {
		lines = append(lines, `{"choices":[{"delta":{},"finish_reason":"stop"}]}`)
	}
	if script.Usage {
		lines = append(lines, `{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}`)
	}
	sse(w, append(lines, "[DONE]")...)
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
