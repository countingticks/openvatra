package hw

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"reflect"
	"runtime"
	"testing"
)

func TestParseDevicesRealOutput(t *testing.T) {
	// Captured from the bundled llama-server (b12078, Vulkan) with `--list-devices`, CRLF line ends included.
	out, err := os.ReadFile("testdata/list-devices-b12078.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := []GPU{{Name: "NVIDIA GeForce RTX 4070 SUPER", Vendor: VendorNVIDIA, TotalBytes: 12213 * mib, FreeBytes: 11033 * mib}}
	if got := ParseDevices(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseDevicesEdgeCases(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want []GPU
	}{
		{"no devices", "Available devices:\n", nil},
		{"empty", "", nil},
		{
			"brackets in the name, driver logs around it",
			"ggml_vulkan: Found 2 Vulkan devices:\nAvailable devices:\n" +
				"  Vulkan0: AMD Radeon(TM) Graphics (4096 MiB, 3000 MiB free)\n" +
				"  Vulkan1: Intel(R) Arc(TM) A770 Graphics (16032 MiB, 15800 MiB free)\n",
			[]GPU{
				{Name: "AMD Radeon(TM) Graphics", Vendor: VendorAMD, TotalBytes: 4096 * mib, FreeBytes: 3000 * mib},
				{Name: "Intel(R) Arc(TM) A770 Graphics", Vendor: VendorIntel, TotalBytes: 16032 * mib, FreeBytes: 15800 * mib},
			},
		},
		{"unknown vendor", "  CUDA0: Some Accelerator (8000 MiB, 1 MiB free)", []GPU{
			{Name: "Some Accelerator", Vendor: VendorOther, TotalBytes: 8000 * mib, FreeBytes: 1 * mib},
		}},
		{"memory missing", "  Vulkan0: NVIDIA GeForce GTX 1060\n", nil},
		{"number too large", "  Vulkan0: X (99999999999999999999 MiB, 1 MiB free)\n", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ParseDevices([]byte(tt.out)); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestVendorOf(t *testing.T) {
	tests := map[string]string{
		"NVIDIA GeForce RTX 3060":        VendorNVIDIA,
		"Quadro P2000":                   VendorNVIDIA,
		"AMD Radeon RX 7900 XTX":         VendorAMD,
		"Radeon(TM) 780M":                VendorAMD,
		"Intel(R) UHD Graphics 770":      VendorIntel,
		"Microsoft Basic Render Driver":  VendorOther,
		"Research GPU (not an arc card)": VendorOther,
	}
	for name, want := range tests {
		if got := vendorOf(name); got != want {
			t.Errorf("vendorOf(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestBestPicksMostMemory(t *testing.T) {
	gpus := []GPU{{Name: "igpu", TotalBytes: 2}, {Name: "big", TotalBytes: 8}, {Name: "also big", TotalBytes: 8}}
	if got := best(gpus); got.Name != "big" {
		t.Fatalf("best = %q, want big", got.Name)
	}
	if best(nil) != nil {
		t.Fatal("best(nil) should be nil")
	}
}

// fakeChecker counts how often the engine is asked.
func fakeChecker(path *string, out string, listErr error) (*Checker, *int) {
	runs := 0
	c := NewChecker(func() string { return *path }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.listDevices = func(context.Context, string) ([]byte, error) {
		runs++
		return []byte(out), listErr
	}
	c.ram = func() (uint64, error) { return 32 << 30, nil }
	return c, &runs
}

func TestCheckerCachesUntilRefresh(t *testing.T) {
	path := `C:\engine\llama-server.exe`
	c, runs := fakeChecker(&path, "  Vulkan0: NVIDIA GeForce RTX 4070 (12000 MiB, 11000 MiB free)\n", nil)

	r := c.Get()
	if r.GPU == nil || r.GPU.Vendor != VendorNVIDIA || r.RAMBytes != 32<<30 || r.Error != "" {
		t.Fatalf("report = %+v", r)
	}
	c.Get()
	if *runs != 1 {
		t.Fatalf("runs after two Gets = %d, want 1", *runs)
	}
	c.Refresh()
	c.Get()
	if *runs != 2 {
		t.Fatalf("runs after Refresh = %d, want 2", *runs)
	}
}

func TestCheckerFailureMeansNoGPU(t *testing.T) {
	path := `C:\engine\llama-server.exe`
	c, _ := fakeChecker(&path, "", errors.New("exit status 1"))
	r := c.Get()
	if r.GPU != nil || r.Error == "" || r.RAMBytes == 0 {
		t.Fatalf("report = %+v", r)
	}
}

func TestCheckerWithoutEngineIsNotCached(t *testing.T) {
	path := ""
	c, runs := fakeChecker(&path, "  Vulkan0: NVIDIA GeForce RTX 4070 (12000 MiB, 11000 MiB free)\n", nil)
	if r := c.Get(); r.GPU != nil || r.Error == "" || *runs != 0 {
		t.Fatalf("report = %+v, runs = %d", r, *runs)
	}
	path = `C:\engine\llama-server.exe` // main's config arrives
	if r := c.Get(); r.GPU == nil {
		t.Fatalf("report after config = %+v", r)
	}
}

func TestSystemCalls(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("measured on Windows only")
	}
	if ram, err := totalRAM(); err != nil || ram < 1<<30 {
		t.Fatalf("totalRAM = %d, %v", ram, err)
	}
	if free, err := DiskFree(t.TempDir()); err != nil || free == 0 {
		t.Fatalf("DiskFree = %d, %v", free, err)
	}
	if _, err := DiskFree(`Q:\does\not\exist`); err == nil {
		t.Fatal("DiskFree on a missing drive should fail")
	}
}
