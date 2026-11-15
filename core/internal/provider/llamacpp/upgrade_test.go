package llamacpp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/countingticks/openvatra/core/internal/event"
	"github.com/countingticks/openvatra/core/internal/store"
)

func openDB(t *testing.T, dir string) *store.Store {
	t.Helper()
	db, err := store.Open(dir, event.NewBus(16))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func seedProvider(t *testing.T, db *store.Store, value string) {
	t.Helper()
	if _, err := db.ConfigPut(context.Background(), ID, 0, []byte(value)); err != nil {
		t.Fatal(err)
	}
}

// upgrade runs UpgradeOptions and returns the row's rev, its options and the log.
func upgrade(t *testing.T, db *store.Store) (int, map[string]ModelOptions, string) {
	t.Helper()
	var log bytes.Buffer
	if err := UpgradeOptions(context.Background(), db, slog.New(slog.NewTextHandler(&log, nil))); err != nil {
		t.Fatal(err)
	}
	rev, data, err := db.ConfigGet(context.Background(), ID)
	if err != nil {
		t.Fatal(err)
	}
	var s LlamaCppSettings
	if data != nil {
		if err := json.Unmarshal(data, &s); err != nil {
			t.Fatalf("row %s: %v", data, err)
		}
	}
	return rev, s.Options, log.String()
}

const upgradeRow = `{"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,"options":%s}`

func row(options string) string { return strings.Replace(upgradeRow, "%s", options, 1) }

func TestUpgradeOptionsMovesTheFlagsIntoFields(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedProvider(t, db, row(`{"qwen":{"args":"-c 8192 --jinja"},"gemma":{}}`))

	rev, options, log := upgrade(t, db)

	if rev != 2 {
		t.Errorf("rev = %d, want 2", rev)
	}
	if q := options["qwen"]; q.Args != "--jinja" || q.Context == nil || *q.Context != 8192 || q.Placement != "" {
		t.Errorf("qwen = %+v, want context 8192 and --jinja", q)
	}
	if g, ok := options["gemma"]; !ok || g != (ModelOptions{}) {
		t.Errorf("gemma = %+v %v, want {}", g, ok)
	}
	if n := strings.Count(log, "level=INFO"); n != 1 || !strings.Contains(log, "model=qwen") {
		t.Errorf("log = %s, want one Info line for qwen", log)
	}
	if strings.Contains(log, "8192") {
		t.Errorf("log carries the argument text: %s", log)
	}
}

func TestUpgradeOptionsKeepsAFieldAlreadySet(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedProvider(t, db, row(`{"qwen":{"args":"-c 8192 -ngl 20","context":4096,"placement":"cpu"}}`))

	_, options, _ := upgrade(t, db)

	if q := options["qwen"]; q.Args != "" || q.Context == nil || *q.Context != 4096 || q.Placement != "cpu" {
		t.Errorf("qwen = %+v, want context 4096, placement cpu and no args", q)
	}
}

func TestUpgradeOptionsRunsOnce(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedProvider(t, db, row(`{"qwen":{"args":"-c 8192 --jinja"}}`))
	upgrade(t, db)

	rev, _, log := upgrade(t, db)

	if rev != 2 || log != "" {
		t.Errorf("second run: rev %d, log %q; want rev 2 and nothing logged", rev, log)
	}
}

func TestUpgradeOptionsWritesNothing(t *testing.T) {
	cases := map[string]string{
		"no row":                "",
		"broken row":            `{"options":{"qwen":{"args":"-c 8192"}},"surprise":1}`,
		"args that can't split": row(`{"qwen":{"args":"-c \"8192"}}`),
		"no flag to move":       row(`{"qwen":{"args":"--jinja"}}`),
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			db := openDB(t, t.TempDir())
			want := 0
			if value != "" {
				seedProvider(t, db, value)
				want = 1
			}
			var log bytes.Buffer
			if err := UpgradeOptions(context.Background(), db, slog.New(slog.NewTextHandler(&log, nil))); err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			rev, data, err := db.ConfigGet(context.Background(), ID)
			if err != nil || rev != want {
				t.Fatalf("rev = %d, %v; want %d", rev, err, want)
			}
			if value != "" && string(data) != value {
				t.Errorf("row = %s, want it unchanged", data)
			}
		})
	}
	if err := UpgradeOptions(context.Background(), nil, nil); err != nil {
		t.Errorf("no db: err = %v", err)
	}
}

func TestUpgradeOptionsLogsEachDroppedFlag(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedProvider(t, db, row(`{"qwen":{"args":"--n-cpu-moe 4 --temp 0.7"}}`))

	_, options, log := upgrade(t, db)

	if options["qwen"].Args != "--temp 0.7" {
		t.Errorf("qwen = %+v", options["qwen"])
	}
	if !strings.Contains(log, "level=WARN") || !strings.Contains(log, "model=qwen") ||
		!strings.Contains(log, `flag="--n-cpu-moe 4"`) {
		t.Errorf("log = %s, want a Warn line with the model and the flag", log)
	}
}
