package fit

import (
	"testing"

	"github.com/countingticks/openvatra/core/internal/engine"
	"github.com/countingticks/openvatra/core/internal/engine/llamaserver"
	"github.com/countingticks/openvatra/core/internal/hw"
)

const gib = 1 << 30

var needs Needs = llamaserver.New(nil, nil).Needs

// machine is a PC with a GPU of gpuGiB (none when 0) and ramGiB of RAM.
func machine(gpuGiB, ramGiB uint64) hw.Report {
	r := hw.Report{RAMBytes: ramGiB * gib}
	if gpuGiB > 0 {
		r.GPU = &hw.GPU{TotalBytes: gpuGiB * gib}
	}
	return r
}

var (
	// like Qwen3.6 35B A3B
	moe = engine.Shape{
		FileBytes: 21 * gib, ExpertBytes: 19*gib + gib/2, Layers: 40, KVHeads: 2, KeyLen: 256, ValueLen: 256, MaxContext: 262144,
	}
	// a 4B model
	small = engine.Shape{FileBytes: 5 * gib / 2, Layers: 36, KVHeads: 8, KeyLen: 128, ValueLen: 128, MaxContext: 262144}
	// a model that does not fit 12 GiB of VRAM
	big = engine.Shape{FileBytes: 20 * gib, Layers: 40, KVHeads: 8, KeyLen: 128, ValueLen: 128, MaxContext: 32768}
)

func TestChoose(t *testing.T) {
	tests := []struct {
		name      string
		shape     engine.Shape
		hw        hw.Report
		context   int
		placement string
		want      Choice // only the fields set here are compared; Layers is checked by layersBetween
		layers    bool   // Layers must be between 1 and the model's layers - 1
	}{
		{"moe auto: experts at 64K", moe, machine(12, 64), 0, "auto", Choice{Context: 65536, Placement: PlaceExperts, Fit: FitSlower}, false},
		{"dense auto: gpu at 32K", small, machine(12, 32), 0, "auto", Choice{Context: 32768, Placement: PlaceGPU, Fit: FitFits}, false},
		{"too big for VRAM: layers at 8K", big, machine(12, 64), 0, "auto", Choice{Context: 8192, Placement: PlaceLayers, Fit: FitSlower}, true},
		{"no GPU: cpu at 8K", big, machine(0, 64), 0, "auto", Choice{Context: 8192, Placement: PlaceCPU, Fit: FitSlower}, false},
		{"no GPU, little RAM: too big", big, machine(0, 16), 0, "auto", Choice{Context: 8192, Placement: PlaceCPU, Fit: FitTooBig}, false},
		{
			"a maximum under 8K is the only step",
			engine.Shape{FileBytes: gib, Layers: 8, KVHeads: 2, KeyLen: 64, ValueLen: 64, MaxContext: 4096},
			machine(12, 16), 0, "auto", Choice{Context: 4096, Placement: PlaceGPU, Fit: FitFits}, false,
		},
		{"a number above the maximum is capped", small, machine(12, 32), 300000, "gpu", Choice{Context: 262144, Placement: PlaceGPU, Fit: FitTooBig, Capped: true}, false},
		{"a number with auto placement moves the experts", moe, machine(12, 64), 32768, "auto", Choice{Context: 32768, Placement: PlaceExperts, Fit: FitSlower}, false},
		{"a number with auto placement keeps the gpu when it fits", small, machine(12, 32), 8192, "auto", Choice{Context: 8192, Placement: PlaceGPU, Fit: FitFits}, false},
		{"a number with auto placement offloads layers", big, machine(12, 64), 8192, "auto", Choice{Context: 8192, Placement: PlaceLayers, Fit: FitSlower}, true},
		{"a number with auto placement that fits nowhere is too big", big, machine(12, 8), 8192, "auto", Choice{Context: 8192, Placement: PlaceLayers, Fit: FitTooBig}, true},
		{"auto context with experts", moe, machine(12, 64), 0, "experts", Choice{Context: 65536, Placement: PlaceExperts, Fit: FitSlower}, false},
		{"auto context with cpu", small, machine(12, 64), 0, "cpu", Choice{Context: 131072, Placement: PlaceCPU, Fit: FitSlower}, false},
		{"auto context with layers", small, machine(12, 32), 0, "layers", Choice{Context: 65536, Placement: PlaceLayers, Fit: FitSlower}, true},
		{"nothing fits with a fixed placement: the smallest step", big, machine(12, 64), 0, "gpu", Choice{Context: 8192, Placement: PlaceGPU, Fit: FitTooBig}, false},
		{"both fixed", small, machine(12, 32), 16384, "cpu", Choice{Context: 16384, Placement: PlaceCPU, Fit: FitSlower}, false},
		{"experts on a dense model is gpu", small, machine(12, 32), 8192, "experts", Choice{Context: 8192, Placement: PlaceGPU, Fit: FitFits}, false},
		{"an unknown shape loads at 16K on the gpu", engine.Shape{FileBytes: gib}, machine(12, 32), 0, "auto", Choice{Context: 16384, Placement: PlaceGPU, Fit: FitUnknown, Source: "unknown"}, false},
		{"an unknown shape keeps the user's choice", engine.Shape{FileBytes: gib}, machine(12, 32), 4096, "cpu", Choice{Context: 4096, Placement: PlaceCPU, Fit: FitUnknown, Source: "unknown"}, false},
		{"unknown hardware", small, hw.Report{}, 0, "auto", Choice{Context: 16384, Placement: PlaceGPU, Fit: FitUnknown, Source: "unknown"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Check(tt.shape, tt.hw, needs, tt.context, tt.placement)
			if got.Context != tt.want.Context || got.Placement != tt.want.Placement || got.Fit != tt.want.Fit || got.Capped != tt.want.Capped {
				t.Fatalf("choice = %+v, want %+v", got, tt.want)
			}
			if tt.layers != (got.Layers > 0 && got.Layers < tt.shape.Layers) {
				t.Fatalf("Layers = %d of %d, want between 1 and all but one: %v", got.Layers, tt.shape.Layers, tt.layers)
			}
			if tt.want.Fit == FitUnknown {
				if got.Source != "unknown" || got.VRAMBytes != 0 || got.RAMBytes != 0 {
					t.Fatalf("choice = %+v, want source unknown and no bytes", got)
				}
			} else if got.Source != "estimate" || got.VRAMBytes+got.RAMBytes == 0 {
				t.Fatalf("choice = %+v, want the estimate's bytes", got)
			}
		})
	}
}

func TestAutoIsCheckWithNothingChosen(t *testing.T) {
	if a, c := Auto(moe, machine(12, 64), needs), Check(moe, machine(12, 64), needs, 0, ""); a != c {
		t.Fatalf("Auto = %+v, Check = %+v", a, c)
	}
}

func TestLabelEdges(t *testing.T) {
	const context = 8192
	gpu := needs(engine.Spec{Shape: small, Context: context})
	cpu := needs(engine.Spec{Shape: small, Context: context, Placement: engine.Placement{Kind: engine.PlaceCPU}})
	experts := needs(engine.Spec{Shape: moe, Context: context, Placement: engine.Placement{Kind: engine.PlaceExperts}})
	vramFor := func(need int64) uint64 { return uint64((need*10 + 8) / 9) } // the smallest GPU with need ≤ 90% of it

	tests := []struct {
		name      string
		shape     engine.Shape
		hw        hw.Report
		placement string
		want      string
	}{
		{"90% of VRAM exactly", small, hw.Report{GPU: &hw.GPU{TotalBytes: vramFor(gpu.VRAMBytes)}}, PlaceGPU, FitFits},
		{"one byte under 90%", small, hw.Report{GPU: &hw.GPU{TotalBytes: vramFor(gpu.VRAMBytes) - 1}}, PlaceGPU, FitTooBig},
		{"half the RAM exactly", small, hw.Report{RAMBytes: uint64(cpu.RAMBytes) * 2}, PlaceCPU, FitSlower},
		{"one byte under half the RAM", small, hw.Report{RAMBytes: uint64(cpu.RAMBytes)*2 - 1}, PlaceCPU, FitTooBig},
		{
			"experts in RAM are slower, not fits", moe,
			hw.Report{GPU: &hw.GPU{TotalBytes: vramFor(experts.VRAMBytes)}, RAMBytes: uint64(experts.RAMBytes) * 2}, PlaceExperts, FitSlower,
		},
		{
			"experts with one byte too little RAM", moe,
			hw.Report{GPU: &hw.GPU{TotalBytes: vramFor(experts.VRAMBytes)}, RAMBytes: uint64(experts.RAMBytes)*2 - 1}, PlaceExperts, FitTooBig,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Check(tt.shape, tt.hw, needs, context, tt.placement); got.Fit != tt.want {
				t.Fatalf("fit = %q, want %q (%+v)", got.Fit, tt.want, got)
			}
		})
	}
}

func TestSpec(t *testing.T) {
	tests := []struct {
		c    Choice
		want engine.Placement
	}{
		{Choice{Placement: PlaceGPU}, engine.Placement{Kind: engine.PlaceGPU}},
		{Choice{Placement: PlaceExperts}, engine.Placement{Kind: engine.PlaceExperts}},
		{Choice{Placement: PlaceLayers, Layers: 12}, engine.Placement{Kind: engine.PlaceLayers, Layers: 12}},
		{Choice{Placement: PlaceCPU}, engine.Placement{Kind: engine.PlaceCPU}},
	}
	for _, tt := range tests {
		if got := tt.c.Spec(); got != tt.want {
			t.Errorf("%+v: Spec = %+v, want %+v", tt.c, got, tt.want)
		}
	}
}
