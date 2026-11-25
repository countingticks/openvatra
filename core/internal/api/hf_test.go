package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/countingticks/openvatra/core/internal/hf"
)

// stubHF answers with its fields and records what it was asked.
type stubHF struct {
	repos       []hf.Repo
	hasMore     bool
	listing     hf.Listing
	err         error
	q           string
	page        int
	owner, name string
	checkText   string
	checkErr    error
	checked     []string // the paths Check was asked
}

func (s *stubHF) Check(_ context.Context, _, _ string, f hf.GroupFile) (string, error) {
	s.checked = append(s.checked, f.Path)
	return s.checkText, s.checkErr
}

func (s *stubHF) Search(_ context.Context, q string, page int) (hf.SearchPage, error) {
	s.q, s.page = q, page
	return hf.SearchPage{Repos: s.repos, Page: page, HasMore: s.hasMore}, s.err
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
	stub := &stubHF{repos: []hf.Repo{{ID: "o/m", Owner: "o", Name: "m", Tags: []string{"Code"}, Quants: 3}}, hasMore: true}
	rec := getHF(t, stub, "/api/hf/search?q=qwen+coder")
	if rec.Code != http.StatusOK || stub.q != "qwen coder" || stub.page != 0 {
		t.Fatalf("status = %d, q = %q, page = %d, body = %s", rec.Code, stub.q, stub.page, rec.Body.String())
	}
	var body HFSearchBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Repos) != 1 || body.Repos[0].ID != "o/m" ||
		body.Repos[0].Quants != 3 || body.Page != 0 || !body.HasMore {
		t.Fatalf("body = %s (%v)", rec.Body.String(), err)
	}

	stub = &stubHF{}
	rec = getHF(t, stub, "/api/hf/search?q=qwen&page=3")
	if rec.Code != http.StatusOK || stub.page != 3 || !strings.Contains(rec.Body.String(), `"page":3`) {
		t.Fatalf("page 3: status = %d, page = %d, body = %s", rec.Code, stub.page, rec.Body.String())
	}

	rec = getHF(t, &stubHF{}, "/api/hf/search?q=nothing")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"repos":[],"page":0,"hasMore":false}` {
		t.Fatalf("empty result: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	rec = getHF(t, &stubHF{}, "/api/hf/search?q=qwen&page=x")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"error":"invalid_request"`) {
		t.Fatalf("page=x: status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestHFErrors(t *testing.T) {
	const search, files = "/api/hf/search?q=qwen", "/api/hf/repos/o/m/files"
	cases := []struct {
		err    error
		status int
		code   string
		paths  []string
	}{
		{hf.ErrBadQuery, http.StatusBadRequest, "bad_request", []string{search}},
		{hf.ErrBadPage, http.StatusBadRequest, "bad_request", []string{search}},
		{hf.ErrUnreachable, http.StatusBadGateway, "hf_unreachable", []string{search}},
		{hf.ErrBadAnswer, http.StatusBadGateway, "hf_bad_answer", []string{search}},
		{hf.ErrRepoNotFound, http.StatusNotFound, "hf_repo_not_found", []string{files}},
		{hf.ErrGated, http.StatusForbidden, "hf_gated", []string{files}},
		{&hf.RateLimitedError{Wait: 12 * time.Second}, http.StatusTooManyRequests, "hf_rate_limited", []string{search, files}},
	}
	for _, tc := range cases {
		for _, path := range tc.paths {
			t.Run(tc.code+" "+path, func(t *testing.T) {
				rec := getHF(t, &stubHF{err: tc.err}, path)
				var body ErrorBody
				_ = json.Unmarshal(rec.Body.Bytes(), &body)
				if rec.Code != tc.status || body.Error != tc.code || body.Message != tc.err.Error() {
					t.Fatalf("status = %d, body = %s; want %d %s", rec.Code, rec.Body.String(), tc.status, tc.code)
				}
			})
		}
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
