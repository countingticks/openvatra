package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/hf"
)

// HF is what the hf routes need; *hf.Client in production, a stub in tests.
type HF interface {
	Search(ctx context.Context, q string) ([]hf.Repo, error)
	Files(ctx context.Context, owner, name string) (hf.Listing, error)
	Check(ctx context.Context, repo, revision string, f hf.GroupFile) (string, error)
}

type HFSearchQuery struct {
	Q string `query:"q" doc:"2 to 100 characters after trimming"`
}

type HFSearchBody struct {
	Repos []hf.Repo `json:"repos"`
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
				repos, err := h.Search(ctx, in.Q)
				if err != nil {
					return HFSearchBody{}, err
				}
				if repos == nil {
					repos = []hf.Repo{}
				}
				return HFSearchBody{Repos: repos}, nil
			}).
			WithErrors("invalid_request", "bad_request", "hf_unreachable", "hf_bad_answer"),
		JSON(http.MethodGet, "/api/hf/repos/{owner}/{name}/files", UI, "listHfFiles", "A Hugging Face repo's GGUF files for this PC",
			func(ctx context.Context, in HFRepoPath) (hf.Listing, error) { return h.Files(ctx, in.Owner, in.Name) }).
			WithErrors("hf_repo_not_found", "hf_gated", "hf_unreachable", "hf_bad_answer"),
	}
}
