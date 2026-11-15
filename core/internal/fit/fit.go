// Package fit picks the context size and placement a model loads with from its shape and the hardware, and says
// whether a choice the user made fits. It estimates through the engine's Needs and decides nothing about starting.
package fit

import (
	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/hw"
)

// The fit labels: the catalog's three, plus unknown when there is nothing to estimate from.
const (
	FitFits    = "fits"
	FitSlower  = "slower"
	FitTooBig  = "tooBig"
	FitUnknown = "unknown"
)

// The placements a choice can have; auto is only ever an input.
const (
	PlaceAuto    = "auto"
	PlaceGPU     = "gpu"
	PlaceExperts = "experts"
	PlaceLayers  = "layers"
	PlaceCPU     = "cpu"
)

// DefaultContext is what a model loads with when nothing is known about it.
const DefaultContext = 16384

// Steps are the context sizes auto tries, smallest first, each capped at the model's maximum.
var Steps = []int{8192, 16384, 32768, 65536, 131072, 262144}

// moeFloor is the context below which a mixture-of-experts model tries moving its experts to RAM.
const moeFloor = 32768

// Needs is the engine's estimate of what a spec takes.
type Needs func(engine.Spec) engine.Resources

// Choice is a context size and placement with what it costs and how well it fits.
type Choice struct {
	Context   int    `json:"context"`
	Placement string `json:"placement" enum:"gpu,experts,layers,cpu"`
	Layers    int    `json:"layers,omitempty"`
	Fit       string `json:"fit" enum:"fits,slower,tooBig,unknown"`
	VRAMBytes int64  `json:"vramBytes"`
	RAMBytes  int64  `json:"ramBytes"`
	Source    string `json:"source" enum:"estimate,measured,unknown"`
	Capped    bool   `json:"capped"` // the number asked for was above the model's maximum
}

// Spec is the engine placement of the choice.
func (c Choice) Spec() engine.Placement {
	switch c.Placement {
	case PlaceExperts:
		return engine.Placement{Kind: engine.PlaceExperts}
	case PlaceLayers:
		return engine.Placement{Kind: engine.PlaceLayers, Layers: c.Layers}
	case PlaceCPU:
		return engine.Placement{Kind: engine.PlaceCPU}
	}
	return engine.Placement{Kind: engine.PlaceGPU}
}

// MoE says the model is a mixture of experts whose expert weights can sit in RAM.
func MoE(shape engine.Shape) bool { return shape.ExpertBytes > 0 }

// Auto chooses both the context size and the placement.
func Auto(shape engine.Shape, r hw.Report, needs Needs) Choice {
	return Check(shape, r, needs, 0, PlaceAuto)
}

// Check chooses what the user left open. context 0 is auto; placement "" or "auto" is auto.
func Check(shape engine.Shape, r hw.Report, needs Needs, context int, placement string) Choice {
	f := fitter{shape: shape, r: r, needs: needs}
	if placement == "" {
		placement = PlaceAuto
	}
	if placement == PlaceExperts && !MoE(shape) {
		placement = PlaceGPU
	}

	capped := false
	if shape.MaxContext > 0 && context > shape.MaxContext {
		context, capped = shape.MaxContext, true
	}

	if !f.known() {
		return f.unknown(context, placement, capped)
	}
	var c Choice
	switch {
	case context == 0 && placement == PlaceAuto:
		c = f.autoBoth()
	case context == 0:
		c = f.autoContext(placement)
	case placement == PlaceAuto:
		c = f.autoPlacement(context)
	default:
		c = f.eval(context, placement)
	}
	c.Capped = capped
	return c
}

type fitter struct {
	shape engine.Shape
	r     hw.Report
	needs Needs
}

// known: there is an estimate and something to compare it with.
func (f fitter) known() bool {
	probe := f.needs(engine.Spec{Shape: f.shape, Context: Steps[0], Placement: engine.Placement{Kind: engine.PlaceGPU}})
	return probe.Known && (f.r.GPU != nil || f.r.RAMBytes > 0)
}

// unknown loads the way core always did: the user's numbers, else 16384 on the GPU.
func (f fitter) unknown(context int, placement string, capped bool) Choice {
	if context == 0 {
		context = DefaultContext
		if f.shape.MaxContext > 0 && context > f.shape.MaxContext {
			context = f.shape.MaxContext
		}
	}
	if placement != PlaceCPU && placement != PlaceExperts {
		placement = PlaceGPU // layers can't be counted without the estimate, auto has nothing to go on
	}
	return Choice{Context: context, Placement: placement, Fit: FitUnknown, Source: "unknown", Capped: capped}
}

// steps are the context sizes to try for this model.
func (f fitter) steps() []int {
	var out []int
	for _, s := range Steps {
		if m := f.shape.MaxContext; m > 0 && s > m {
			s = m
		}
		if len(out) == 0 || out[len(out)-1] != s {
			out = append(out, s)
		}
	}
	return out
}

func (f fitter) vram() int64 {
	if f.r.GPU == nil {
		return 0
	}
	return int64(f.r.GPU.TotalBytes)
}

// label is decision 26's rule.
func (f fitter) label(res engine.Resources) string {
	inVRAM := res.VRAMBytes*10 <= f.vram()*9
	switch {
	case inVRAM && res.RAMBytes == 0 && f.r.GPU != nil:
		return FitFits
	case inVRAM && res.RAMBytes <= int64(f.r.RAMBytes/2):
		return FitSlower
	}
	return FitTooBig
}

func fitsWell(c Choice) bool { return c.Fit == FitFits || c.Fit == FitSlower }

// eval is one context size with one placement; layers gets the most layers that fit.
func (f fitter) eval(context int, placement string) Choice {
	layers := 0
	if placement == PlaceLayers {
		layers = f.layersThatFit(context)
	}
	return f.build(context, placement, layers)
}

func (f fitter) build(context int, placement string, layers int) Choice {
	p := Choice{Placement: placement, Layers: layers}.Spec()
	res := f.needs(engine.Spec{Shape: f.shape, Context: context, Placement: p})
	return Choice{
		Context: context, Placement: placement, Layers: layers, Fit: f.label(res),
		VRAMBytes: res.VRAMBytes, RAMBytes: res.RAMBytes, Source: res.Source,
	}
}

// layersThatFit is the most layers (below all of them) whose VRAM need stays within 90% of the GPU; 0 without one.
func (f fitter) layersThatFit(context int) int {
	if f.r.GPU == nil {
		return 0
	}
	for n := f.shape.Layers - 1; n > 0; n-- {
		res := f.needs(engine.Spec{Shape: f.shape, Context: context, Placement: engine.Placement{Kind: engine.PlaceLayers, Layers: n}})
		if res.VRAMBytes*10 <= f.vram()*9 {
			return n
		}
	}
	return 0
}

// offload is layers with the most that fit, or cpu when none do.
func (f fitter) offload(context int) Choice {
	c := f.eval(context, PlaceLayers)
	if c.Layers == 0 {
		return f.build(context, PlaceCPU, 0)
	}
	return c
}

// largest is the biggest step whose choice for placement fits.
func (f fitter) largest(placement string) (Choice, bool) {
	steps := f.steps()
	for i := len(steps) - 1; i >= 0; i-- {
		if c := f.eval(steps[i], placement); fitsWell(c) {
			return c, true
		}
	}
	return Choice{}, false
}

// autoBoth is decision 2.
func (f fitter) autoBoth() Choice {
	a, hasA := f.largest(PlaceGPU)
	if MoE(f.shape) && (!hasA || a.Context < moeFloor) {
		if b, ok := f.largest(PlaceExperts); ok && (!hasA || b.Context > a.Context) {
			return b
		}
	}
	if hasA {
		return a
	}
	return f.offload(f.steps()[0])
}

// autoContext is decision 24: the largest step that fits the placement, else the smallest, too big.
func (f fitter) autoContext(placement string) Choice {
	if c, ok := f.largest(placement); ok {
		return c
	}
	return f.eval(f.steps()[0], placement)
}

// autoPlacement takes the first placement that fits at the size the user chose; none does, it is the offload.
func (f fitter) autoPlacement(context int) Choice {
	order := []string{PlaceGPU}
	if MoE(f.shape) {
		order = append(order, PlaceExperts)
	}
	for _, p := range order {
		if c := f.eval(context, p); fitsWell(c) {
			return c
		}
	}
	return f.offload(context)
}
