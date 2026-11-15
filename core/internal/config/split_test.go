package config

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func splitLogger(buf *bytes.Buffer) *slog.Logger { return slog.New(slog.NewTextHandler(buf, nil)) }

func seedModels(t *testing.T, db DB, value string) {
	t.Helper()
	if _, err := db.ConfigPut(context.Background(), legacySection, 0, []byte(value)); err != nil {
		t.Fatal(err)
	}
}

func assertSection(t *testing.T, db DB, name string, wantRev int, want string) {
	t.Helper()
	rev, got, err := db.ConfigGet(context.Background(), name)
	if err != nil || rev != wantRev {
		t.Fatalf("%s: rev %d, %v", name, rev, err)
	}
	if want == "" {
		return
	}
	var a, b any
	if err := json.Unmarshal(got, &a); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatal(err)
	}
	ga, _ := json.Marshal(a)
	gb, _ := json.Marshal(b)
	if string(ga) != string(gb) {
		t.Fatalf("%s = %s, want %s", name, ga, gb)
	}
}

func TestSplitModelsMovesAFullRow(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedModels(t, db, `{"llamaServerPath":"C:\\llama\\llama-server.exe","modelsDir":"D:\\Models",`+
		`"embeddingModel":"nomic","idleUnloadMinutes":30,`+
		`"options":{"a":{"args":"-c 4096"},"b":{}},"engine":"cuda"}`)
	var log bytes.Buffer
	if err := SplitModels(context.Background(), db, splitLogger(&log)); err != nil {
		t.Fatal(err)
	}
	assertSection(t, db, engineSection, 1, `{"path":"C:\\llama\\llama-server.exe","build":"cuda"}`)
	assertSection(t, db, providerSection, 1, `{"modelsDir":"D:\\Models","embeddingModel":"nomic",`+
		`"idleUnloadMinutes":30,"options":{"a":{"args":"-c 4096"},"b":{}}}`)
	assertSection(t, db, legacySection, 0, "")
	if !strings.Contains(log.String(), "split the models config section into engine.llamaserver and provider.llamacpp") {
		t.Fatalf("log = %s", log.String())
	}
}

// The default row is what DefaultModels() marshalled to before the split.
func TestSplitModelsMovesTheDefaultRow(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedModels(t, db, `{"llamaServerPath":null,"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,`+
		`"options":{},"engine":"bundled"}`)
	if err := SplitModels(context.Background(), db, splitLogger(&bytes.Buffer{})); err != nil {
		t.Fatal(err)
	}
	assertSection(t, db, engineSection, 1, `{"path":null,"build":"bundled"}`)
	assertSection(t, db, providerSection, 1,
		`{"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,"options":{}}`)
}

func TestSplitModelsDeletesARowThatDoesNotDecode(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedModels(t, db, `{"engine":"bundled","surprise":1}`)
	var log bytes.Buffer
	if err := SplitModels(context.Background(), db, splitLogger(&log)); err != nil {
		t.Fatal(err)
	}
	assertSection(t, db, legacySection, 0, "")
	assertSection(t, db, engineSection, 0, "")
	assertSection(t, db, providerSection, 0, "")
	if !strings.Contains(log.String(), "stored models section is invalid; both new sections start from their defaults") ||
		!strings.Contains(log.String(), "surprise") {
		t.Fatalf("log = %s", log.String())
	}
}

func TestSplitModelsSecondRunDoesNothing(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedModels(t, db, `{"llamaServerPath":null,"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,`+
		`"options":{},"engine":"bundled"}`)
	if err := SplitModels(context.Background(), db, splitLogger(&bytes.Buffer{})); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	if err := SplitModels(context.Background(), db, splitLogger(&log)); err != nil {
		t.Fatal(err)
	}
	assertSection(t, db, engineSection, 1, "")
	assertSection(t, db, providerSection, 1, "")
	if log.Len() != 0 {
		t.Fatalf("log = %s", log.String())
	}
}

func TestSplitModelsKeepsExistingNewSections(t *testing.T) {
	db := openDB(t, t.TempDir())
	seedModels(t, db, `{"llamaServerPath":null,"modelsDir":null,"embeddingModel":null,"idleUnloadMinutes":15,`+
		`"options":{},"engine":"cuda"}`)
	if _, err := db.ConfigPut(context.Background(), engineSection, 0, []byte(`{"path":null,"build":"bundled"}`)); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	if err := SplitModels(context.Background(), db, splitLogger(&log)); err != nil {
		t.Fatal(err)
	}
	assertSection(t, db, legacySection, 0, "")
	assertSection(t, db, engineSection, 1, `{"path":null,"build":"bundled"}`)
	assertSection(t, db, providerSection, 0, "")
	if !strings.Contains(log.String(), "dropped the models config section; the new sections already exist") {
		t.Fatalf("log = %s", log.String())
	}
}

func TestSplitModelsWithoutADatabase(t *testing.T) {
	if err := SplitModels(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePath(t *testing.T) {
	abs := t.TempDir()
	if err := ValidatePath("dir", nil); err != nil {
		t.Fatalf("nil: %v", err)
	}
	if err := ValidatePath("dir", &abs); err != nil {
		t.Fatalf("absolute: %v", err)
	}
	for _, p := range []string{"", `rel\dir`, abs + "\x00"} {
		if err := ValidatePath("dir", &p); err == nil || err.Error() != "dir must be an absolute path" {
			t.Errorf("%q: %v", p, err)
		}
	}
}
