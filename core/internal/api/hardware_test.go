package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/hw"
)

// stubHardware answers Get with no GPU and Refresh with one, so a test can tell which was called.
type stubHardware struct{}

func (stubHardware) Get() hw.Report { return hw.Report{RAMBytes: 16, Error: "no GPU found"} }

func (stubHardware) Refresh() hw.Report {
	return hw.Report{GPU: &hw.GPU{Name: "RTX", Vendor: hw.VendorNVIDIA, TotalBytes: 8, FreeBytes: 4}, RAMBytes: 16}
}

func TestHardwareEndpoints(t *testing.T) {
	tests := []struct {
		method, path, want string
	}{
		{http.MethodGet, "/api/hardware", `{"gpu":null,"ramBytes":16,"error":"no GPU found"}`},
		{http.MethodPost, "/api/hardware/refresh",
			`{"gpu":{"name":"RTX","vendor":"nvidia","totalBytes":8,"freeBytes":4},"ramBytes":16}`},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(tt.method, tt.path, nil)
		req.Host = "127.0.0.1:53121"
		req.Header.Set("Authorization", "Bearer "+testToken)
		rec := httptest.NewRecorder()
		NewHandler(testToken, testPort, func() {}, nil, nil, nil, stubHardware{}, stubCatalog{}, nil, nil).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != tt.want {
			t.Errorf("%s %s: status = %d, body = %s", tt.method, tt.path, rec.Code, rec.Body.String())
		}
	}
}

func TestHardwareNeedsToken(t *testing.T) {
	rec := do(t, "/api/hardware", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
