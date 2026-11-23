package store

import (
	"errors"
	"os"
	"slices"
	"strconv"
	"testing"
	"testing/fstest"
	"time"

	"github.com/countingticks/openvatra/core/internal/event"
)

// embeddedUpTo is the embedded migrations 0001 to n, under the same root: a database as an older build left it.
func embeddedUpTo(t *testing.T, n int) fstest.MapFS {
	t.Helper()
	entries, err := embedded.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	out := fstest.MapFS{}
	for _, e := range entries {
		if v, err := strconv.Atoi(e.Name()[:4]); err == nil && v <= n {
			data, err := embedded.ReadFile("migrations/" + e.Name())
			if err != nil {
				t.Fatal(err)
			}
			out["migrations/"+e.Name()] = &fstest.MapFile{Data: data}
		}
	}
	return out
}

func fitFixture() (FitModel, FitPlace) {
	return FitModel{ModelID: "qwen", Args: "--jinja", FileBytes: 1000, FileMtime: time.Unix(1700000000, 5)},
		FitPlace{Context: 32768, Placement: "gpu"}
}

// sameFits compares ignoring order and the measured time.
func sameFits(t *testing.T, got []ModelFit, want ...ModelFit) {
	t.Helper()
	for i := range got {
		got[i].MeasuredAt = time.Time{}
	}
	key := func(f ModelFit) string { return f.Placement + string(rune(f.Layers+'0')) }
	slices.SortFunc(got, func(a, b ModelFit) int { return compareStrings(key(a), key(b)) })
	slices.SortFunc(want, func(a, b ModelFit) int { return compareStrings(key(a), key(b)) })
	if !slices.Equal(got, want) {
		t.Fatalf("fits = %+v, want %+v", got, want)
	}
}

func compareStrings(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func TestModelFitMemoryAndSpeedMakeOneRow(t *testing.T) {
	s := newStore(t)
	m, p := fitFixture()
	must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 0))
	must(0, s.RecordFitSpeed(ctx, m, p, 23.6))
	got := must(s.ModelFits(ctx, m))
	if len(got) != 1 {
		t.Fatalf("fits = %+v, want one row", got)
	}
	// The fixed clock moves 1 s per call: the speed write is the second.
	if want := time.Date(2026, 11, 4, 12, 0, 2, 0, time.UTC); !got[0].MeasuredAt.Equal(want) {
		t.Fatalf("measured at %v, want %v", got[0].MeasuredAt, want)
	}
	sameFits(t, got, ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, TokensPerSecond: 23.6})
}

func TestModelFitSpeedFirstHasNoMemory(t *testing.T) {
	s := newStore(t)
	m, p := fitFixture()
	must(0, s.RecordFitSpeed(ctx, m, p, 12))
	sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, TokensPerSecond: 12})
}

func TestModelFitLaterWriteKeepsTheOtherMeasurement(t *testing.T) {
	m, p := fitFixture()
	t.Run("memory keeps the speed", func(t *testing.T) {
		s := newStore(t)
		must(0, s.RecordFitSpeed(ctx, m, p, 12))
		must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 0))
		sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, TokensPerSecond: 12})
	})
	t.Run("speed keeps the memory", func(t *testing.T) {
		s := newStore(t)
		must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 0))
		must(0, s.RecordFitSpeed(ctx, m, p, 15))
		sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, TokensPerSecond: 15})
	})
}

func TestModelFitNewFileTimeReplacesTheRow(t *testing.T) {
	s := newStore(t)
	m, p := fitFixture()
	must(0, s.RecordFitSpeed(ctx, m, p, 12))
	m.FileMtime = m.FileMtime.Add(time.Second)
	must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 0))
	sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000})
}

func TestModelFitsLeaveStaleRowsOut(t *testing.T) {
	s := newStore(t)
	m, p := fitFixture()
	must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 0))
	other := map[string]func(FitModel) FitModel{
		"file size": func(m FitModel) FitModel { m.FileBytes++; return m },
		"file time": func(m FitModel) FitModel { m.FileMtime = m.FileMtime.Add(1); return m },
		"args":      func(m FitModel) FitModel { m.Args = ""; return m },
		"projector": func(m FitModel) FitModel { m.Projector = true; return m },
	}
	for name, change := range other {
		if got := must(s.ModelFits(ctx, change(m))); len(got) != 0 {
			t.Fatalf("%s: fits = %+v, want none", name, got)
		}
	}
	sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000})
}

func TestModelFitsPerPlaceAndModel(t *testing.T) {
	s := newStore(t)
	m, p := fitFixture()
	experts := FitPlace{Context: 8192, Placement: "experts"}
	must(0, s.RecordFitMemory(ctx, m, p, 1, 2, 0))
	must(0, s.RecordFitMemory(ctx, m, experts, 3, 4, 0))
	m2 := m
	m2.ModelID = "other"
	must(0, s.RecordFitMemory(ctx, m2, p, 5, 6, 0))
	sameFits(t, must(s.ModelFits(ctx, m)),
		ModelFit{FitPlace: p, Memory: true, VRAMBytes: 1, RAMBytes: 2},
		ModelFit{FitPlace: experts, Memory: true, VRAMBytes: 3, RAMBytes: 4})
}

func TestModelFitLayersAreSeparateRows(t *testing.T) {
	s := newStore(t)
	m, _ := fitFixture()
	twelve := FitPlace{Context: 8192, Placement: "layers", Layers: 12}
	twenty := FitPlace{Context: 8192, Placement: "layers", Layers: 20}
	must(0, s.RecordFitMemory(ctx, m, twelve, 1, 2, 0))
	must(0, s.RecordFitMemory(ctx, m, twenty, 3, 4, 0))
	sameFits(t, must(s.ModelFits(ctx, m)),
		ModelFit{FitPlace: twelve, Memory: true, VRAMBytes: 1, RAMBytes: 2},
		ModelFit{FitPlace: twenty, Memory: true, VRAMBytes: 3, RAMBytes: 4})
}

func TestModelFitReadOnlyStoreRefusesWrites(t *testing.T) {
	var migration []byte
	for _, name := range []string{"0005_model_fit.sql", "0008_model_fit_fit.sql"} {
		b, err := os.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		migration = append(migration, b...)
	}
	s := readOnlyConfigStore(t, func(s *Store) {
		if _, err := s.writer().Exec(string(migration)); err != nil {
			t.Fatal(err)
		}
	})
	m, p := fitFixture()
	if err := s.RecordFitMemory(ctx, m, p, 1, 2, 0); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("memory: %v", err)
	}
	if err := s.RecordFitSpeed(ctx, m, p, 1); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("speed: %v", err)
	}
	if got, err := s.ModelFits(ctx, m); err != nil || len(got) != 0 {
		t.Fatalf("fits = %+v, %v", got, err)
	}
}

func TestModelFitKeepsTheExpertLayersUntilTheNextMemoryWrite(t *testing.T) {
	s := newStore(t)
	m, _ := fitFixture()
	p := FitPlace{Context: 65536, Placement: "experts"}
	must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 16))
	sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, GPUExpertLayers: 16})
	must(0, s.RecordFitSpeed(ctx, m, p, 30))
	sameFits(t, must(s.ModelFits(ctx, m)),
		ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, TokensPerSecond: 30, GPUExpertLayers: 16})
	must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 0))
	sameFits(t, must(s.ModelFits(ctx, m)),
		ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, TokensPerSecond: 30})
}

func TestMigration0008ForgetsFitsMeasuredUnderTheOldFlags(t *testing.T) {
	dir := t.TempDir()
	old, err := open(dir, event.NewBus(16), embeddedUpTo(t, 7), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	m, p := fitFixture()
	if _, err := old.writer().Exec(`INSERT INTO model_fit (model_id, projector, args, context, placement, layers, file_bytes,
		file_mtime, vram_bytes, ram_bytes, measured_at) VALUES (?, 0, ?, ?, ?, 0, ?, ?, 1, 2, 3)`,
		m.ModelID, m.Args, p.Context, p.Placement, m.FileBytes, m.FileMtime.UnixNano()); err != nil {
		t.Fatal(err)
	}
	old.Close()

	s, err := Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := must(s.ModelFits(ctx, m)); len(got) != 0 {
		t.Fatalf("fits = %+v, want none after the migration", got)
	}
	must(0, s.RecordFitMemory(ctx, m, p, 6000, 2000, 16))
	sameFits(t, must(s.ModelFits(ctx, m)), ModelFit{FitPlace: p, Memory: true, VRAMBytes: 6000, RAMBytes: 2000, GPUExpertLayers: 16})
}
