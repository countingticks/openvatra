package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/hf"
)

// HF is what the hf routes need; *hf.Client in production, a stub in tests.
type HF interface {
	Search(ctx context.Context, q string, page int) (hf.SearchPage, error)
	Files(ctx context.Context, owner, name string) (hf.Listing, error)
	Check(ctx context.Context, repo, revision string, f hf.GroupFile) (string, error)
}

type HFSearchQuery struct {
	Q    string `query:"q" doc:"2 to 100 characters after trimming"`
	Page int    `query:"page" doc:"0 to 9; default 0"`
}

type HFSearchBody struct {
	Repos   []hf.Repo `json:"repos"`
	Page    int       `json:"page"`
	HasMore bool      `json:"hasMore"`
}

type HFRepoPath struct {
	Owner string `path:"owner"`
	Name  string `path:"name"`
}

// hfRoutes are the only callers of Hugging Face: nothing asks it at start or in the background.
func hfRoutes(h HF) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/hf/search", UI, "searchHf", "Search Hugging Face for GGUF models",
			func(ctx context.Context, in HFSearchQuery) (HFSearchBody, error) {
				p, err := h.Search(ctx, in.Q, in.Page)
				if err != nil {
					return HFSearchBody{}, err
				}
				if p.Repos == nil {
					p.Repos = []hf.Repo{}
				}
				return HFSearchBody{Repos: p.Repos, Page: p.Page, HasMore: p.HasMore}, nil
			}).
			WithErrors("invalid_request", "bad_request", "hf_unreachable", "hf_bad_answer", "hf_rate_limited"),
		JSON(http.MethodGet, "/api/hf/repos/{owner}/{name}/files", UI, "listHfFiles", "A Hugging Face repo's GGUF files for this PC",
			func(ctx context.Context, in HFRepoPath) (hf.Listing, error) { return h.Files(ctx, in.Owner, in.Name) }).
			WithErrors("hf_repo_not_found", "hf_gated", "hf_unreachable", "hf_bad_answer", "hf_rate_limited"),
	}
}
