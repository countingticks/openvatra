package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/hw"
)

// Hardware is what the hardware endpoints need; *hw.Checker in production, a stub in tests.
type Hardware interface {
	Get() hw.Report
	Refresh() hw.Report
}

// hardwareRoutes answer with a report; a failed measurement is still 200, with the reason in its error field, because
// "no GPU" is an answer the UI shows, not a broken request.
func hardwareRoutes(h Hardware) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/hardware", UI, "getHardware", "The PC's hardware, as last measured",
			func(context.Context, struct{}) (hw.Report, error) { return h.Get(), nil }),
		JSON(http.MethodPost, "/api/hardware/refresh", UI, "refreshHardware", "Measure the PC's hardware again",
			func(context.Context, struct{}) (hw.Report, error) { return h.Refresh(), nil }),
	}
}
