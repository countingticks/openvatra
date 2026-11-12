package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/config"
)

// stubCatalog knows one model, "qwen", stored in D:\Models\qwen.
type stubCatalog struct{}

func (stubCatalog) View() catalog.View {
	id := "qwen"
	return catalog.View{
		Entries:     []catalog.Item{{Entry: catalog.Entry{ID: id, Tags: []string{"chat"}}, Fit: catalog.FitFits}},
		Recommended: &id,
	}
}

func (stubCatalog) Folder(id string) (string, error) {
	if id != "qwen" {
		return "", catalog.ErrUnknown
	}
	return `D:\Models\qwen`, nil
}

func getCatalog(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	NewHandler(testToken, testPort, func() {}, nil, nil, config.NewOverride(), stubHardware{}, stubCatalog{}, nil, nil).ServeHTTP(rec, req)
	return rec
}

func TestCatalogEndpoint(t *testing.T) {
	rec := getCatalog(t, "/api/catalog")
	body := rec.Body.String()
	for _, want := range []string{`"id":"qwen"`, `"fit":"fits"`, `"installed":false`, `"diskFreeBytes":null`, `"recommended":"qwen"`} {
		if rec.Code != http.StatusOK || !strings.Contains(body, want) {
			t.Fatalf("status = %d, body = %s; missing %s", rec.Code, body, want)
		}
	}
}

func TestCatalogFolderEndpoint(t *testing.T) {
	tests := []struct {
		path   string
		status int
		want   string
	}{
		{"/api/catalog/qwen/folder", http.StatusOK, `{"folder":"D:\\Models\\qwen"}`},
		{"/api/catalog/other/folder", http.StatusNotFound, `"error":"unknown_model"`},
	}
	for _, tt := range tests {
		rec := getCatalog(t, tt.path)
		if rec.Code != tt.status || !strings.Contains(rec.Body.String(), tt.want) {
			t.Errorf("%s: status = %d, body = %s", tt.path, rec.Code, rec.Body.String())
		}
	}
}
