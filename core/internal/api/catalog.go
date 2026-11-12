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

type CatalogFolder struct {
	Folder string `json:"folder"`
}

func catalogRoutes(c Catalog) []Route {
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
	}
}
