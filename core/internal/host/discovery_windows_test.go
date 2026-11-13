//go:build windows

package host

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func sampleDiscovery() Discovery {
	return Discovery{
		PID:       os.Getpid(),
		Port:      51234,
		Token:     strings.Repeat("ab", 32),
		Version:   "0.1.0",
		API:       1,
		Exe:       `C:\app\resources\core\core.exe`,
		Args:      []string{"--data-dir", `C:\data`},
		StartedAt: time.Date(2026, 11, 13, 9, 12, 0, 0, time.UTC),
	}
}

func TestDiscoveryRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := sampleDiscovery()
	if err := WriteDiscovery(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := ReadDiscovery(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !got.StartedAt.Equal(want.StartedAt) {
		t.Errorf("StartedAt = %v, want %v", got.StartedAt, want.StartedAt)
	}
	got.StartedAt, want.StartedAt = time.Time{}, time.Time{}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("read %+v, want %+v", got, want)
	}
}

func TestDiscoveryFileIsOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDiscovery(dir, sampleDiscovery()); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(filepath.Join(dir, DiscoveryFile), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Error("DACL is not protected")
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl.AceCount != 1 {
		t.Fatalf("DACL has %d entries, want 1", dacl.AceCount)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if err := windows.GetAce(dacl, 0, &ace); err != nil {
		t.Fatal(err)
	}
	if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
		t.Errorf("ACE type %d, want allow", ace.Header.AceType)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
	if !sid.Equals(user.User.Sid) {
		t.Errorf("ACE is for %s, want %s", sid, user.User.Sid)
	}
}

func TestWriteDiscoveryReplacesExisting(t *testing.T) {
	dir := t.TempDir()
	first := sampleDiscovery()
	if err := WriteDiscovery(dir, first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.Port = 60000
	if err := WriteDiscovery(dir, second); err != nil {
		t.Fatal(err)
	}
	got, err := ReadDiscovery(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != 60000 {
		t.Errorf("port %d after rewrite, want 60000", got.Port)
	}
	if _, err := os.Stat(filepath.Join(dir, DiscoveryFile+".tmp")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("core.json.tmp left behind: %v", err)
	}
}

func TestNilArgsWrittenAsEmptyArray(t *testing.T) {
	dir := t.TempDir()
	d := sampleDiscovery()
	d.Args = nil
	if err := WriteDiscovery(dir, d); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, DiscoveryFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"args":[]`) {
		t.Errorf("file holds %s, want \"args\":[]", raw)
	}
	got, err := ReadDiscovery(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Args == nil || len(got.Args) != 0 {
		t.Errorf("Args = %#v, want an empty slice", got.Args)
	}
}

func TestReadDiscoveryErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadDiscovery(dir); !errors.Is(err, ErrNoDiscovery) {
		t.Errorf("empty folder: %v, want ErrNoDiscovery", err)
	}
	if err := os.WriteFile(filepath.Join(dir, DiscoveryFile), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadDiscovery(dir); err == nil || errors.Is(err, ErrNoDiscovery) {
		t.Errorf("invalid JSON: %v, want a parse error", err)
	}
}

func TestRemoveDiscovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, DiscoveryFile)
	if err := RemoveDiscovery(dir, os.Getpid()); err != nil {
		t.Errorf("empty folder: %v, want nil", err)
	}
	if err := WriteDiscovery(dir, sampleDiscovery()); err != nil {
		t.Fatal(err)
	}
	if err := RemoveDiscovery(dir, os.Getpid()+1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("another pid removed the file: %v", err)
	}
	if err := RemoveDiscovery(dir, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("file still there after RemoveDiscovery with our pid: %v", err)
	}
}
