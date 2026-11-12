package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"unicode"
	"unicode/utf8"

	"github.com/countingticks/openvatra/core/internal/config"
)

// Config is what the config routes need; *config.Store implements it.
type Config interface {
	All() map[string]config.SectionEntry
	Section(name string) (config.SectionEntry, error)
	Put(name string, rev int, value json.RawMessage) (config.SectionEntry, error)
	Sections() []config.SectionType
}

type ConfigAll struct {
	Sections map[string]config.SectionEntry `json:"sections"`
}

var errConfigUnavailable = &Error{Status: http.StatusServiceUnavailable, Code: "config_unavailable",
	Message: "config storage is not available"}

// configRoutes are GET /api/config plus a typed GET and PUT per registered section, in registration order. Without
// a store (tests only) there are no section routes and GET /api/config answers 503.
func configRoutes(cfg Config) []Route {
	routes := []Route{
		JSON(http.MethodGet, "/api/config", UI, "getConfig", "Every config section",
			func(context.Context, struct{}) (ConfigAll, error) {
				if cfg == nil {
					return ConfigAll{}, errConfigUnavailable
				}
				return ConfigAll{cfg.All()}, nil
			}).
			WithErrors("config_unavailable"),
	}
	if cfg == nil {
		return routes
	}
	for _, sec := range cfg.Sections() {
		routes = append(routes, sectionRoutes(cfg, sec)...)
	}
	return routes
}

func sectionRoutes(cfg Config, sec config.SectionType) []Route {
	name := sec.Name
	r, size := utf8.DecodeRuneInString(name)
	title := string(unicode.ToUpper(r)) + name[size:]
	path := "/api/config/" + name

	revField := reflect.StructField{Name: "Rev", Type: reflect.TypeFor[int](), Tag: `json:"rev"`}
	valueField := reflect.StructField{Name: "Value", Type: sec.Value, Tag: `json:"value"`}
	outFields := []reflect.StructField{revField, valueField}
	if sec.Effective != nil {
		outFields = append(outFields,
			reflect.StructField{Name: "Effective", Type: sec.Effective, Tag: `json:"effective,omitempty"`})
	}
	in := reflect.StructOf([]reflect.StructField{revField, valueField})
	out := reflect.StructOf(outFields)

	return []Route{
		// The entry is answered as the store keeps it: the same bytes as GET /api/config shows.
		jsonRoute(http.MethodGet, path, UI, "getConfig"+title, fmt.Sprintf("The %s config section", name),
			reflect.TypeFor[struct{}](), out,
			func(context.Context, any) (any, error) { return cfg.Section(name) }).
			WithErrors("internal"),
		jsonRoute(http.MethodPut, path, UI, "putConfig"+title,
			fmt.Sprintf("Replace the %s config section if rev is still current", name), in, out,
			func(_ context.Context, body any) (any, error) {
				v := reflect.ValueOf(body)
				rev := int(v.Field(0).Int())
				if rev < 0 {
					return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_config",
						Message: `the body must be {"rev": n, "value": {…}}`}
				}
				// The wrapper already rejected wrong types and unknown fields; the store's own decode and Validate
				// judge the rest.
				value, err := json.Marshal(v.Field(1).Interface())
				if err != nil {
					return nil, err
				}
				entry, err := cfg.Put(name, rev, value)
				if errors.Is(err, config.ErrConflict) {
					current, _ := cfg.Section(name)
					return nil, &Error{Status: http.StatusConflict, Code: "config_conflict",
						Message: "the section changed since it was read", Extra: map[string]any{"current": current}}
				}
				if err != nil {
					return nil, err
				}
				return entry, nil
			}).
			WithErrors("invalid_request", "invalid_config", "config_conflict", "config_unavailable", "internal"),
	}
}
