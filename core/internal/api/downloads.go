package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/countingticks/openvatra/core/internal/downloads"
	"github.com/countingticks/openvatra/core/internal/feed"
	"github.com/countingticks/openvatra/core/internal/hf"
	"github.com/countingticks/openvatra/core/internal/store"
)

// Downloads is what the download endpoints and the event need; *downloads.Manager in production, a stub in tests.
type Downloads interface {
	Items() []downloads.DownloadItem
	Subscribe() (<-chan struct{}, func())
	Start(id string) error
	StartEngine() error
	StartPick(ctx context.Context, p store.HFPick) error
	Resume(id string) error
	Pause(id string) error
	Cancel(id string) error
}

// StartDownload queues a catalog model, the CUDA engine, or one quant of a Hugging Face repo.
type StartDownload struct {
	CatalogID string   `json:"catalogId,omitempty"`
	Engine    string   `json:"engine,omitempty" enum:"cuda"`
	HF        *HFStart `json:"hf,omitempty"`
}

// HFStart names a quant of a Hugging Face repo, as GET /api/hf/repos/{owner}/{name}/files lists it.
type HFStart struct {
	Repo  string `json:"repo" doc:"owner/name"`
	Quant string `json:"quant"`
}

func (s StartDownload) Validate() error {
	given := 0
	for _, set := range []bool{s.CatalogID != "", s.Engine != "", s.HF != nil} {
		if set {
			given++
		}
	}
	if given != 1 {
		return &Error{Status: http.StatusBadRequest, Code: "bad_request",
			Message: `send exactly one of "catalogId", "engine" or "hf"`}
	}
	if s.HF != nil && strings.Count(s.HF.Repo, "/") != 1 {
		return &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: `"hf.repo" must be "owner/name"`}
	}
	return nil
}

var errQuantNotFound = &Error{Status: http.StatusNotFound, Code: "hf_quant_not_found",
	Message: "that repo has no such quant"}

// startPick reads the repo's listing (usually from the hf cache) and queues the group named quant, pinned at the
// listing's revision.
func startPick(ctx context.Context, dl Downloads, h HF, in HFStart) error {
	owner, name, _ := strings.Cut(in.Repo, "/")
	listing, err := h.Files(ctx, owner, name)
	if err != nil {
		return err
	}
	for _, g := range listing.Groups {
		if g.Quant != in.Quant {
			continue
		}
		if err := checkGroup(ctx, h, in.Repo, listing.Revision, g); err != nil {
			return err
		}
		pick := store.HFPick{ID: "hf:" + in.Repo + ":" + in.Quant, Repo: in.Repo, Revision: listing.Revision, Quant: in.Quant}
		for _, f := range g.Files {
			pick.Files = append(pick.Files, store.HFPickFile{Name: f.Name, Path: f.Path, SizeBytes: f.SizeBytes, SHA256: f.SHA256})
		}
		return dl.StartPick(ctx, pick)
	}
	return errQuantNotFound
}

// checkGroup refuses a group whose one model file is not a complete model. Only a single-file group that isn't
// installed is checked: a split group would cost a request per part, and an installed one gets already_installed
// from the queue. A check that fails lets the download start; the scanner still catches the file afterwards. A check
// refused for the rate limit is the answer, so the user retries instead of skipping the check.
func checkGroup(ctx context.Context, h HF, repo, revision string, g hf.Group) error {
	if g.Installed {
		return nil
	}
	var model []hf.GroupFile
	for _, f := range g.Files {
		if !f.Projector {
			model = append(model, f)
		}
	}
	if len(model) != 1 {
		return nil
	}
	text, err := h.Check(ctx, repo, revision, model[0])
	if errors.Is(err, hf.ErrRateLimited) {
		return err
	}
	if err != nil || text == "" {
		return nil
	}
	return &Error{Status: http.StatusUnprocessableEntity, Code: "hf_incomplete_model", Message: text}
}

func downloadRoutes(dl Downloads, h HF) []Route {
	accepted := StatusBody{"accepted"}
	return []Route{
		JSON(http.MethodGet, "/api/downloads", UI, "listDownloads", "The download queue",
			func(context.Context, struct{}) (feed.DownloadsBody, error) {
				var items []downloads.DownloadItem
				if dl != nil {
					items = dl.Items()
				}
				if items == nil {
					items = []downloads.DownloadItem{}
				}
				return feed.DownloadsBody{Items: items}, nil
			}),
		JSON(http.MethodPost, "/api/downloads", UI, "startDownload",
			"Queue a catalog model, the CUDA engine or a Hugging Face quant",
			func(ctx context.Context, in StartDownload) (StatusBody, error) {
				switch {
				case in.Engine != "":
					return accepted, dl.StartEngine()
				case in.HF != nil:
					return accepted, startPick(ctx, dl, h, *in.HF)
				}
				return accepted, dl.Start(in.CatalogID)
			}).
			WithStatus(http.StatusAccepted).
			WithErrors("invalid_request", "bad_request", "unknown_model", "no_models_folder", "already_installed",
				"not_enough_space", "hf_repo_not_found", "hf_gated", "hf_unreachable", "hf_bad_answer",
				"hf_rate_limited", "hf_quant_not_found", "hf_incomplete_model", "downloads_unavailable", "internal"),
		JSON(http.MethodDelete, "/api/downloads/{id}", UI, "cancelDownload", "Cancel a download and drop its partial files",
			func(_ context.Context, in ModelPath) (StatusBody, error) { return accepted, dl.Cancel(in.ID) }).
			WithStatus(http.StatusAccepted).
			WithErrors("unknown_model", "no_download", "internal"),
		JSON(http.MethodPost, "/api/downloads/{id}/resume", UI, "resumeDownload", "Resume a paused or failed download",
			func(_ context.Context, in ModelPath) (StatusBody, error) { return accepted, dl.Resume(in.ID) }).
			WithStatus(http.StatusAccepted).
			WithErrors("unknown_model", "no_download", "no_models_folder", "already_installed", "not_enough_space",
				"not_paused", "internal"),
		JSON(http.MethodPost, "/api/downloads/{id}/pause", UI, "pauseDownload", "Pause a download",
			func(_ context.Context, in ModelPath) (StatusBody, error) { return accepted, dl.Pause(in.ID) }).
			WithStatus(http.StatusAccepted).
			WithErrors("unknown_model", "not_running", "internal"),
	}
}
