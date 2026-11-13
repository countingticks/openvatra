package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/catalog"
	"github.com/countingticks/openvatra/core/internal/removal"
)

// stubCatalog knows one model, "qwen", stored in D:\Models\qwen.
type stubCatalog struct{}

func (stubCatalog) View() catalog.View {
	id := "qwen"
	return catalog.View{
		Entries:     []catalog.Item{{Entry: catalog.Entry{ID: id, Tags: []string{"chat"}, Files: []catalog.File{}}, Fit: catalog.FitFits}},
		Recommended: &id,
	}
}

func getCatalog(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	testHandler(t, Deps{}).ServeHTTP(rec, req)
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

// The folder route moved into core's removal: nothing asks main for a folder any more.
func TestCatalogFolderRouteIsGone(t *testing.T) {
	if rec := getCatalog(t, "/api/catalog/qwen/folder"); rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// stubRemoval answers with err and records the ids it was asked to remove.
type stubRemoval struct {
	err error
	ids []string
}

func (s *stubRemoval) Remove(_ context.Context, id string) error {
	s.ids = append(s.ids, id)
	return s.err
}

func postRemove(t *testing.T, h http.Handler, token, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/catalog/"+id+"/remove", nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRemoveCatalogEntry(t *testing.T) {
	rm := &stubRemoval{}
	rec := postRemove(t, testHandler(t, Deps{Removal: rm}), testToken, "qwen")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	if len(rm.ids) != 1 || rm.ids[0] != "qwen" {
		t.Errorf("removed %v, want [qwen]", rm.ids)
	}
}

func TestRemoveCatalogEntryErrors(t *testing.T) {
	tests := []struct {
		err     error
		status  int
		code    string
		message string
	}{
		{removal.ErrUnknownEntry, http.StatusNotFound, "unknown_catalog_entry", removal.ErrUnknownEntry.Error()},
		{catalog.ErrNoFolder, http.StatusConflict, "no_models_folder", "no models folder is set"},
		{removal.ErrOutside, http.StatusConflict, "outside_models_folder", removal.ErrOutside.Error()},
		{removal.ErrNotInstalled, http.StatusConflict, "not_installed", removal.ErrNotInstalled.Error()},
		{removal.ErrUnloadTimeout, http.StatusConflict, "unload_timeout", removal.ErrUnloadTimeout.Error()},
		{fmt.Errorf("%w: %v", removal.ErrTrashFailed, errors.New("trash: SHFileOperationW failed: 0x7c")),
			http.StatusInternalServerError, "trash_failed", removal.ErrTrashFailed.Error()},
		{errors.New("boom"), http.StatusInternalServerError, "internal", "core hit an unexpected error"},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			rec := postRemove(t, testHandler(t, Deps{Removal: &stubRemoval{err: tt.err}}), testToken, "qwen")
			var body ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body %s: %v", rec.Body, err)
			}
			if rec.Code != tt.status || body.Error != tt.code || body.Message != tt.message {
				t.Errorf("got %d %+v, want %d %s %q", rec.Code, body, tt.status, tt.code, tt.message)
			}
		})
	}
}

func TestRemoveCatalogEntryAllowsUIToken(t *testing.T) {
	rm := &stubRemoval{}
	h := testHandler(t, Deps{Removal: rm})
	req := httptest.NewRequest(http.MethodPost, "/api/tokens", strings.NewReader(`{"scope":"ui"}`))
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var tok TokenBody
	if err := json.Unmarshal(rec.Body.Bytes(), &tok); rec.Code != http.StatusCreated || err != nil {
		t.Fatalf("issue = %d %s", rec.Code, rec.Body)
	}
	if rec := postRemove(t, h, tok.Token, "qwen"); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}
