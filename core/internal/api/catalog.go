package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/countingticks/openvatra/core/internal/catalog"
)

// Catalog is what the catalog endpoints need; *catalog.Catalog in production, a stub in tests.
type Catalog interface {
	View() catalog.View
	Folder(id string) (string, error)
}

func catalogHandler(c Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(c.View())
	}
}

// catalogFolderHandler tells main which folder to move to the Recycle Bin. Main still checks it is inside the models
// folder before touching it.
func catalogFolderHandler(c Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		folder, err := c.Folder(r.PathValue("id"))
		switch {
		case errors.Is(err, catalog.ErrUnknown):
			writeCode(w, http.StatusNotFound, "unknown_model", "not a catalog model")
			return
		case err != nil:
			writeCode(w, http.StatusConflict, "no_models_folder", "no models folder is set")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"folder": folder})
	}
}
