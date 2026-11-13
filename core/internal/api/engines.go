package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/downloads"
)

// engineRoutes reports the llama.cpp builds. With no reader (tests, the document) nothing is installed.
func engineRoutes(engines func() downloads.EnginesBody) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/engines", UI, "getEngines", "The llama.cpp builds on this PC",
			func(context.Context, struct{}) (downloads.EnginesBody, error) {
				if engines == nil {
					return downloads.EnginesBody{Cuda: "none"}, nil
				}
				return engines(), nil
			}),
	}
}
