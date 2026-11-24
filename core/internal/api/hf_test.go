package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/hf"
)

// stubHF answers with its fields and records what it was asked.
type stubHF struct {
	repos       []hf.Repo
	listing     hf.Listing
	err         error
	q           string
	owner, name string
	checkText   string
	checkErr    error
	checked     []string // the paths Check was asked
}

func (s *stubHF) Check(_ context.Context, _, _ string, f hf.GroupFile) (string, error) {
	s.checked = append(s.checked, f.Path)
	return s.checkText, s.checkErr
}

func (s *stubHF) Search(_ context.Context, q string) ([]hf.Repo, error) {
	s.q = q
	return s.repos, s.err
}

func (s *stubHF) Files(_ context.Context, owner, name string) (hf.Listing, error) {
	s.owner, s.name = owner, name
	return s.listing, s.err
}

func getHF(t *testing.T, stub *stubHF, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:53121"
	req.Header.Set("Authorization", "Bearer "+testToken)
	rec := httptest.NewRecorder()
	testHandler(t, Deps{HF: stub}).ServeHTTP(rec, req)
	return rec
}

func TestHFSearchPassesTheQueryThrough(t *testing.T) {
	stub := &stubHF{repos: []hf.Repo{{ID: "o/m", Owner: "o", Name: "m", Tags: []string{"Code"}}}}
	rec := getHF(t, stub, "/api/hf/search?q=qwen+coder")
	if rec.Code != http.StatusOK || stub.q != "qwen coder" {
		t.Fatalf("status = %d, q = %q, body = %s", rec.Code, stub.q, rec.Body.String())
	}
	var body HFSearchBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Repos) != 1 || body.Repos[0].ID != "o/m" {
		t.Fatalf("body = %s (%v)", rec.Body.String(), err)
	}

	rec = getHF(t, &stubHF{}, "/api/hf/search?q=nothing")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"repos":[]}` {
		t.Fatalf("empty result: status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestHFErrors(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{hf.ErrBadQuery, http.StatusBadRequest, "bad_request"},
		{hf.ErrUnreachable, http.StatusBadGateway, "hf_unreachable"},
		{hf.ErrBadAnswer, http.StatusBadGateway, "hf_bad_answer"},
		{hf.ErrRepoNotFound, http.StatusNotFound, "hf_repo_not_found"},
		{hf.ErrGated, http.StatusForbidden, "hf_gated"},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			path := "/api/hf/search?q=qwen"
			if tc.err == hf.ErrRepoNotFound || tc.err == hf.ErrGated {
				path = "/api/hf/repos/o/m/files"
			}
			rec := getHF(t, &stubHF{err: tc.err}, path)
			var body ErrorBody
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
			if rec.Code != tc.status || body.Error != tc.code || body.Message != tc.err.Error() {
				t.Fatalf("status = %d, body = %s; want %d %s", rec.Code, rec.Body.String(), tc.status, tc.code)
			}
		})
	}
}

func TestHFFilesPassesTheRepoThrough(t *testing.T) {
	free := uint64(77)
	stub := &stubHF{listing: hf.Listing{
		Repo: "o/m", Revision: strings.Repeat("a", 40), Tags: []string{}, DiskFreeBytes: &free,
		Groups: []hf.Group{{Quant: "Q4_0", Files: []hf.GroupFile{{Name: "m-Q4_0.gguf", SizeBytes: 10, SHA256: strings.Repeat("b", 64), Path: "sub/m-Q4_0.gguf"}}, SizeBytes: 10, Fit: "fits"}},
	}}
	rec := getHF(t, stub, "/api/hf/repos/o/m/files")
	if rec.Code != http.StatusOK || stub.owner != "o" || stub.name != "m" {
		t.Fatalf("status = %d, asked %q/%q, body = %s", rec.Code, stub.owner, stub.name, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{`"diskFreeBytes":77`, `"quant":"Q4_0"`, `"name":"m-Q4_0.gguf"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body = %s; missing %s", body, want)
		}
	}
	if strings.Contains(body, "sub/") {
		t.Fatalf("the repo path leaked into the answer: %s", body)
	}
}
