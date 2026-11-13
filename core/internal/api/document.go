package api

import (
	"net/http"
	"reflect"

	"github.com/countingticks/openvatra/core/internal/api/openapi"
)

var scopeNames = map[Scope]string{None: "none", UI: "ui", Shell: "shell"}

// Document is the OpenAPI document of Routes(d), deterministic for equal Deps. Handlers are never called.
func Document(d Deps) []byte { return documentOf(Routes(d), d.Version) }

func documentOf(routes []Route, version string) []byte {
	r := openapi.NewReflector()
	ops := make([]openapi.Operation, 0, len(routes))
	for _, rt := range routes {
		op := openapi.Operation{
			Method: rt.Method, Path: rt.Path, OperationID: rt.OperationID, Summary: rt.Summary, Tag: rt.Tag,
			Scope: scopeNames[rt.Scope], In: rt.In, Out: rt.Out, Status: rt.Status, ContentType: rt.ContentType,
			Errors: rt.Errors,
		}
		if rt.In == reflect.TypeFor[struct{}]() {
			op.In = nil
		}
		if rt.Out == noContentType {
			op.Out, op.Status = nil, http.StatusNoContent
		}
		if rt.Stream != nil && rt.Stream.Schema != nil {
			op.OutSchema = rt.Stream.Schema(r)
		}
		ops = append(ops, op)
	}
	return openapi.Build(openapi.Info{Title: "OpenVatra core", Version: version, APILevel: APILevel}, ops, r,
		reflect.TypeFor[ErrorBody]())
}
