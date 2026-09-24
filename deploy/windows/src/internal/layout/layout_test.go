package layout

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseIDPattern(t *testing.T) {
	good := []string{"2026.09.24-win-rc1", "2026.09.23-5", "2026.12.31-a", "2026.01.01-win-rc10"}
	for _, id := range good {
		if !ReleaseIDPattern.MatchString(id) {
			t.Errorf("%q should be a legal release id", id)
		}
	}
	// Every rejection below is a name that would either traverse, alias another directory, or be
	// unrepresentable on Windows. A release id becomes a directory name, so the check happens here and
	// not after a Join.
	bad := []string{
		"", "..", ".", "2026.09.24", "2026.09.24-", "2026.09.24-WIN", "2026.9.24-a",
		"../2026.09.24-a", "2026.09.24-a/b", `2026.09.24-a\b`, "2026.09.24-a:b",
		"C:2026.09.24-a", "2026.09.24-a ", " 2026.09.24-a", "2026.09.24-a.",
		strings.Repeat("2026.09.24-a", 10),
	}
	for _, id := range bad {
		if ReleaseIDPattern.MatchString(id) {
			t.Errorf("%q should NOT be a legal release id", id)
		}
	}
}

func TestReleaseRejectsIllegalID(t *testing.T) {
	tree := At(t.TempDir())
	for _, id := range []string{"..", "../escape", `..\escape`, "", "C:/Windows"} {
		if _, err := tree.Release(id); err == nil {
			t.Errorf("Release(%q) was accepted", id)
		}
		if _, err := tree.AppDir(id); err == nil {
			t.Errorf("AppDir(%q) was accepted", id)
		}
	}
}

func TestReleasePathStaysInsideReleases(t *testing.T) {
	root := t.TempDir()
	tree := At(root)
	dir, err := tree.Release("2026.09.24-win-rc1")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "releases", "2026.09.24-win-rc1")
	if dir != want {
		t.Errorf("Release() = %q, want %q", dir, want)
	}
}

func TestPointerRoundTripAndReadBack(t *testing.T) {
	root := t.TempDir()
	tree := At(root)
	if err := tree.EnsureDirs(); err != nil {
		t.Fatal(err)
	}

	if _, err := tree.ActiveRelease(); !errors.Is(err, ErrNoActiveRelease) {
		t.Errorf("a fresh tree should have no active release, got %v", err)
	}

	if err := WritePointer(tree.CurrentFile(), "2026.09.24-win-rc1"); err != nil {
		t.Fatal(err)
	}
	got, err := tree.ActiveRelease()
	if err != nil {
		t.Fatal(err)
	}
	if got != "2026.09.24-win-rc1" {
		t.Errorf("ActiveRelease() = %q", got)
	}

	// Replacing a pointer must replace it, not append to it or nest anything. This is the Windows
	// counterpart of the UOS defect where `mv -f` onto a symlink-to-directory moved the new pointer
	// INSIDE the old release while reporting success.
	if err := WritePointer(tree.CurrentFile(), "2026.09.25-win-rc2"); err != nil {
		t.Fatal(err)
	}
	got, err = tree.ActiveRelease()
	if err != nil {
		t.Fatal(err)
	}
	if got != "2026.09.25-win-rc2" {
		t.Errorf("after replacement ActiveRelease() = %q", got)
	}
	if info, err := os.Stat(tree.CurrentFile()); err != nil || info.IsDir() {
		t.Error("current.txt is not a plain file after replacement")
	}
	if _, err := os.Stat(tree.CurrentFile() + ".new"); err == nil {
		t.Error("the temporary pointer file was left behind")
	}
}

func TestWritePointerRefusesIllegalID(t *testing.T) {
	root := t.TempDir()
	tree := At(root)
	if err := tree.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"..", "../x", ""} {
		if err := WritePointer(tree.CurrentFile(), id); err == nil {
			t.Errorf("WritePointer accepted %q", id)
		}
	}
	if _, err := os.Stat(tree.CurrentFile()); err == nil {
		t.Error("a refused write still created the pointer file")
	}
}

func TestReadPointerRejectsGarbage(t *testing.T) {
	root := t.TempDir()
	tree := At(root)
	if err := tree.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	// An empty or whitespace-only pointer means "nothing is active", which is a normal state after a
	// failed activation and must not be an error.
	for _, body := range []string{"", "   ", "\r\n"} {
		if err := os.WriteFile(tree.CurrentFile(), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := tree.ActiveRelease(); !errors.Is(err, ErrNoActiveRelease) {
			t.Errorf("pointer %q should read as no-active-release, got %v", body, err)
		}
	}
	// A pointer holding something that is not a release id is a corruption, and must be loud.
	for _, body := range []string{"../escape", "not-a-release", `..\..\Windows`} {
		if err := os.WriteFile(tree.CurrentFile(), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := tree.ActiveRelease(); err == nil || errors.Is(err, ErrNoActiveRelease) {
			t.Errorf("pointer %q should be reported as illegal, got %v", body, err)
		}
	}
}

func stageRelease(t *testing.T, tree Tree, id string, extra ...string) string {
	t.Helper()
	dir, err := tree.Release(id)
	if err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"app", "server"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"VERSION", "SHA256SUMS.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range extra {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestAssertReleaseShape(t *testing.T) {
	tree := At(t.TempDir())
	if err := tree.EnsureDirs(); err != nil {
		t.Fatal(err)
	}

	stageRelease(t, tree, "2026.09.24-win-rc1")
	if err := tree.AssertReleaseShape("2026.09.24-win-rc1"); err != nil {
		t.Fatalf("a correct release was rejected: %v", err)
	}

	// An unexpected entry is how a nested or half-extracted payload shows up. Phase 3 had exactly this:
	// two concurrent installers both reported success while one had nested its payload inside the other.
	stageRelease(t, tree, "2026.09.25-win-rc2", "stray.txt")
	err := tree.AssertReleaseShape("2026.09.25-win-rc2")
	if err == nil {
		t.Fatal("a release with an extra entry was accepted")
	}
	if !strings.Contains(err.Error(), "stray.txt") {
		t.Errorf("the refusal does not name the offending entry: %v", err)
	}

	// A missing required entry.
	dir := stageRelease(t, tree, "2026.09.26-win-rc3")
	if err := os.RemoveAll(filepath.Join(dir, "server")); err != nil {
		t.Fatal(err)
	}
	if err := tree.AssertReleaseShape("2026.09.26-win-rc3"); err == nil {
		t.Fatal("a release missing server\\ was accepted")
	}

	// A required entry that is a file where a directory belongs.
	dir = stageRelease(t, tree, "2026.09.27-win-rc4")
	if err := os.RemoveAll(filepath.Join(dir, "app")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := tree.AssertReleaseShape("2026.09.27-win-rc4"); err == nil {
		t.Fatal("a release whose app\\ is a file was accepted")
	}
}

func TestInstalledReleasesIgnoresNoise(t *testing.T) {
	tree := At(t.TempDir())
	if err := tree.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	stageRelease(t, tree, "2026.09.24-win-rc1")
	stageRelease(t, tree, "2026.09.25-win-rc2")
	if err := os.MkdirAll(filepath.Join(tree.Releases(), "scratch"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree.Releases(), "note.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ids, err := tree.InstalledReleases()
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Errorf("InstalledReleases() = %v, want the two real releases only", ids)
	}
}

func TestInstalledReleasesOnMissingTree(t *testing.T) {
	tree := At(filepath.Join(t.TempDir(), "never-created"))
	ids, err := tree.InstalledReleases()
	if err != nil {
		t.Errorf("a missing releases directory should not be an error: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("got %v, want nothing", ids)
	}
}

func TestEnsureDirsIsRepeatable(t *testing.T) {
	tree := At(t.TempDir())
	for i := 0; i < 3; i++ {
		if err := tree.EnsureDirs(); err != nil {
			t.Fatalf("EnsureDirs failed on call %d: %v", i+1, err)
		}
	}
	for _, dir := range []string{tree.Releases(), tree.Bin(), tree.State(), tree.Logs()} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Errorf("%s was not created", dir)
		}
	}
}
