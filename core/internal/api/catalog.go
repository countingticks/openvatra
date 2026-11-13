package api

import (
	"context"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/catalog"
)

// Catalog is what the catalog endpoints need; *catalog.Catalog in production, a stub in tests.
type Catalog interface {
	View() catalog.View
}

// Removal takes a downloaded catalog model off the disk; *removal.Remover in production.
type Removal interface {
	Remove(ctx context.Context, id string) error
}

func catalogRoutes(c Catalog, rm Removal) []Route {
	return []Route{
		JSON(http.MethodGet, "/api/catalog", UI, "getCatalog", "The models to download, judged against this PC",
			func(context.Context, struct{}) (catalog.View, error) { return c.View(), nil }),
		// Answers when the folder is in the Recycle Bin, which can take a while: the model is stopped first.
		JSON(http.MethodPost, "/api/catalog/{id}/remove", UI, "removeCatalogEntry", "Move a downloaded model to the Recycle Bin",
			func(ctx context.Context, in ModelPath) (NoContent, error) { return NoContent{}, rm.Remove(ctx, in.ID) }).
			WithErrors("unknown_catalog_entry", "no_models_folder", "outside_models_folder", "not_installed",
				"unload_timeout", "trash_failed", "internal"),
	}
}
