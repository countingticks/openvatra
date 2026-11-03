package api

import (
	"encoding/json"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/hw"
)

// Hardware is what the hardware endpoints need; *hw.Checker in production, a stub in tests.
type Hardware interface {
	Get() hw.Report
	Refresh() hw.Report
}

// hardwareHandler answers with a report; a failed measurement is still 200, with the reason in its error field,
// because "no GPU" is an answer the UI shows, not a broken request.
func hardwareHandler(measure func() hw.Report) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(measure())
	}
}
