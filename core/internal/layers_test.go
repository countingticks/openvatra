package internal_test

import (
	"errors"
	"go/build"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// layer orders the packages: a package may import its own layer and the ones below it, never above.
type layer int

const (
	foundation layer = iota
	seamLayer
	application
	adapter
	impl // outside the order: an implementation reaches only its own seam, foundations and approved modules
)

type pkg struct {
	layer layer
	seams []string // impl only: the seam packages it implements, e.g. "engine"
}

const modPrefix = "github.com/countingticks/openvatra/core/internal/"

// layers is every package under internal/, keyed by its path below it.
var layers = map[string]pkg{
	"config":   {layer: foundation},
	"download": {layer: foundation},
	"event":    {layer: foundation},
	"host":     {layer: foundation},
	"logs":     {layer: foundation},
	"seam":     {layer: foundation},
	"store":    {layer: foundation},
	"trash":    {layer: foundation},
	// a test-only fixture of the openapi tests
	"api/openapi/internal/clash": {layer: foundation},

	"engine":                {layer: seamLayer},
	"engine/enginetest":     {layer: seamLayer},
	"provider":              {layer: seamLayer},
	"provider/providertest": {layer: seamLayer},

	"catalog":   {layer: application},
	"downloads": {layer: application},
	"feed":      {layer: application},
	"fit":       {layer: application},
	"hw":        {layer: application},
	"models":    {layer: application},
	"removal":   {layer: application},

	"api":         {layer: adapter},
	"api/openapi": {layer: adapter},

	"engine/llamaserver": {layer: impl, seams: []string{"engine"}},
	"provider/llamacpp":  {layer: impl, seams: []string{"provider", "engine"}},
}

// exceptions are imports that break a rule; an unused one is itself a violation. None are left.
var exceptions [][2]string

// approved are the third-party modules an implementation may import.
var approved = []string{"golang.org/x/sys/windows", "modernc.org/sqlite"}

// violations checks imports (package below internal/ -> its full import paths) against the layer rules.
func violations(layers map[string]pkg, imports map[string][]string, exceptions [][2]string) []string {
	var out []string
	used := map[[2]string]bool{}
	excused := func(from, to string) bool {
		for _, e := range exceptions {
			if e == [2]string{from, to} {
				used[e] = true
				return true
			}
		}
		return false
	}
	add := func(from, to, rule string) { out = append(out, from+" imports "+to+": "+rule) }

	for from, imps := range imports {
		fp, listed := layers[from]
		if !listed {
			out = append(out, from+": not listed in layers")
		}
		for _, imp := range imps {
			to, internal := strings.CutPrefix(imp, modPrefix)
			if !internal {
				if listed && fp.layer == impl && !stdlibOrApproved(imp) {
					add(from, imp, "an implementation may import only its seam, seam, foundations, the standard library and approved modules")
				}
				continue
			}
			if to == "api" {
				add(from, to, "nothing imports api")
			}
			tp, toListed := layers[to]
			if !listed || !toListed {
				continue
			}
			if excused(from, to) {
				continue
			}
			switch {
			case fp.layer == impl:
				if !slices.Contains(fp.seams, to) && to != "seam" && tp.layer != foundation {
					add(from, to, "an implementation may import only its seam, seam and foundations")
				}
			case tp.layer != impl && tp.layer > fp.layer:
				add(from, to, "imports a higher layer")
			}
			if tp.layer == impl {
				add(from, to, "nothing imports an implementation")
			}
		}
	}
	for path := range layers {
		if _, ok := imports[path]; !ok {
			out = append(out, path+": listed in layers but no such package")
		}
	}
	for _, e := range exceptions {
		if !used[e] {
			out = append(out, e[0]+" imports "+e[1]+": stale exception")
		}
	}
	slices.Sort(out)
	return out
}

func stdlibOrApproved(imp string) bool {
	if first, _, _ := strings.Cut(imp, "/"); !strings.Contains(first, ".") {
		return true
	}
	for _, a := range approved {
		if imp == a || strings.HasPrefix(imp, a+"/") {
			return true
		}
	}
	return false
}

// loadImports reads the non-test imports of every package under internal/; tests may reach any package for fakes.
func loadImports(t *testing.T) map[string][]string {
	t.Helper()
	imports := map[string][]string{}
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() || path == "." {
			return err
		}
		if d.Name() == "testdata" {
			return filepath.SkipDir
		}
		p, err := build.Default.ImportDir(path, 0)
		var noGo *build.NoGoError
		if errors.As(err, &noGo) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(p.GoFiles)+len(p.CgoFiles) == 0 {
			return nil // only tests: not a package
		}
		imports[filepath.ToSlash(path)] = p.Imports
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return imports
}

func TestLayers(t *testing.T) {
	if got := violations(layers, loadImports(t), exceptions); len(got) > 0 {
		t.Fatalf("%d layer violations:\n%s", len(got), strings.Join(got, "\n"))
	}
}

func TestViolations(t *testing.T) {
	m := func(p string) string { return modPrefix + p }
	ls := map[string]pkg{
		"found": {layer: foundation},
		"seam":  {layer: foundation},
		"eng":   {layer: seamLayer},
		"eng2":  {layer: seamLayer},
		"app":   {layer: application},
		"app2":  {layer: application},
		"api":   {layer: adapter},
		"impl":  {layer: impl, seams: []string{"eng"}},
		"impl2": {layer: impl, seams: []string{"eng"}},
		"impl3": {layer: impl, seams: []string{"eng", "eng2"}},
	}
	graph := func(edges map[string][]string) map[string][]string {
		g := map[string][]string{}
		for p := range ls {
			g[p] = nil
		}
		for p, imps := range edges {
			g[p] = imps
		}
		return g
	}
	cases := map[string]struct {
		edges      map[string][]string
		exceptions [][2]string
		drop       string // a package left out of the graph
		add        string // a package in the graph but not in ls
		want       []string
	}{
		"clean": {edges: map[string][]string{"impl": {m("eng"), m("seam"), m("found"), "fmt", "golang.org/x/sys/windows"}, "app": {m("eng"), m("found")}}},
		"foundation importing application": {
			edges: map[string][]string{"found": {m("app")}},
			want:  []string{"found imports app: imports a higher layer"},
		},
		"application packages importing each other": {
			edges: map[string][]string{"app": {m("app2")}, "app2": {m("app")}},
		},
		"impl importing an application package": {
			edges: map[string][]string{"impl": {m("app")}},
			want:  []string{"impl imports app: an implementation may import only its seam, seam and foundations"},
		},
		"impl importing a second listed seam": {
			edges: map[string][]string{"impl3": {m("eng"), m("eng2")}},
		},
		"impl importing an unlisted seam": {
			edges: map[string][]string{"impl": {m("eng2")}},
			want:  []string{"impl imports eng2: an implementation may import only its seam, seam and foundations"},
		},
		"impl importing another impl": {
			edges: map[string][]string{"impl": {m("impl2")}},
			want: []string{
				"impl imports impl2: an implementation may import only its seam, seam and foundations",
				"impl imports impl2: nothing imports an implementation",
			},
		},
		"impl importing a third-party module": {
			edges: map[string][]string{"impl": {"github.com/x/y"}},
			want:  []string{"impl imports github.com/x/y: an implementation may import only its seam, seam, foundations, the standard library and approved modules"},
		},
		"application importing an impl": {
			edges: map[string][]string{"app": {m("impl")}},
			want:  []string{"app imports impl: nothing imports an implementation"},
		},
		"application importing an impl, excepted": {
			edges:      map[string][]string{"app": {m("impl")}},
			exceptions: [][2]string{{"app", "impl"}},
		},
		"unused exception": {
			exceptions: [][2]string{{"app", "impl"}},
			want:       []string{"app imports impl: stale exception"},
		},
		"importing api": {
			edges: map[string][]string{"app": {m("api")}},
			want: []string{
				"app imports api: imports a higher layer",
				"app imports api: nothing imports api",
			},
		},
		"unlisted package":  {add: "stray", want: []string{"stray: not listed in layers"}},
		"listed but absent": {drop: "app2", want: []string{"app2: listed in layers but no such package"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			g := graph(tc.edges)
			if tc.drop != "" {
				delete(g, tc.drop)
			}
			if tc.add != "" {
				g[tc.add] = nil
			}
			got := violations(ls, g, tc.exceptions)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("violations =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tc.want, "\n"))
			}
		})
	}
}
