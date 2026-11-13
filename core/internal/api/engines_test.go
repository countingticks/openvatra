package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/countingticks/openvatra/core/internal/downloads"
)

func getEngines(t *testing.T, engines func() downloads.EnginesBody) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/engines", nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	testHandler(t, Deps{Engines: engines}).ServeHTTP(rec, req)
	return rec
}

func TestEnginesEndpoint(t *testing.T) {
	tag := "b12078"
	tests := []struct {
		name    string
		engines func() downloads.EnginesBody
		want    string
	}{
		{"reported", func() downloads.EnginesBody {
			return downloads.EnginesBody{Bundled: downloads.BundledEngine{Tag: &tag}, Cuda: "stale"}
		}, `{"bundled":{"tag":"b12078"},"cuda":"stale"}`},
		{"no reader", nil, `{"bundled":{"tag":null},"cuda":"none"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := getEngines(t, tt.engines)
			if got := rec.Body.String(); rec.Code != http.StatusOK || got != tt.want+"\n" {
				t.Errorf("status = %d, body = %q, want %s", rec.Code, got, tt.want)
			}
		})
	}
}
