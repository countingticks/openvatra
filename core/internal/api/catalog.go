package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/catalog"
)

// Catalog is what the catalog endpoints need; *catalog.Catalog in production, a stub in tests.
type Catalog interface {
	View() catalog.View
	Folder(id string) (string, error)
}

// Removal takes a downloaded catalog model off the disk; *removal.Remover in production.
type Removal interface {
	Remove(ctx context.Context, id string) error
}

type CatalogFolder struct {
	Folder string `json:"folder"`
}

func catalogRoutes(c Catalog, rm Removal) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/catalog", UI, "getCatalog", "The models to download, judged against this PC",
			func(context.Context, struct{}) (catalog.View, error) { return c.View(), nil }),
		// Tells main which folder to move to the Recycle Bin. Main still checks it is inside the models folder before
		// touching it.
		JSON(http.MethodGet, "/api/catalog/{id}/folder", Shell, "getCatalogFolder", "The folder a catalog model lives in",
			func(_ context.Context, in ModelPath) (CatalogFolder, error) {
				folder, err := c.Folder(in.ID)
				return CatalogFolder{folder}, err
			}).
			WithErrors("unknown_model", "no_models_folder", "internal"),
		// Answers when the folder is in the Recycle Bin, which can take a while: the model is stopped first.
		JSON(http.MethodPost, "/api/catalog/{id}/remove", UI, "removeCatalogEntry", "Move a downloaded model to the Recycle Bin",
			func(ctx context.Context, in ModelPath) (NoContent, error) { return NoContent{}, rm.Remove(ctx, in.ID) }).
			WithErrors("unknown_catalog_entry", "no_models_folder", "outside_models_folder", "not_installed",
				"unload_timeout", "trash_failed", "internal"),
	}
}
