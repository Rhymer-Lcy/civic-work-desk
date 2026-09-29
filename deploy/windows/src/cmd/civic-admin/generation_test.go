package main

import (
	"os"
	"path/filepath"
	"testing"

	"civicworkdesk/windows/internal/layout"
)

// fakeRelease writes only what guardDataGeneration reads. schema 0 writes an RC3-shaped health file,
// which carries no schema at all.
func fakeRelease(t *testing.T, tree layout.Tree, id string, schema int) {
	t.Helper()
	dir := filepath.Join(tree.Releases(), id)
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	health := `{"application":"civic-work-desk","releaseId":"` + id + `"}`
	version := "CivicWorkDesk\nreleaseId=" + id + "\n"
	if schema > 0 {
		health = `{"application":"civic-work-desk","releaseId":"` + id + `","databaseSchemaVersion":` +
			string(rune('0'+schema)) + `}`
		version += "databaseSchemaVersion=" + string(rune('0'+schema)) + "\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "deployment-health.json"), []byte(health), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "VERSION"), []byte(version), 0o644); err != nil {
		t.Fatal(err)
	}
}

const (
	rc3 = "2026.09.24-win-rc3"
	rc1 = "2026.09.29-win-0.2.0-rc.1"
	v03 = "2026.12.01-win-0.3.0"
)

func TestGuardDataGeneration(t *testing.T) {
	tree := layout.At(t.TempDir())
	fakeRelease(t, tree, rc3, 0) // schema 1 by definition
	fakeRelease(t, tree, rc1, 2)
	fakeRelease(t, tree, v03, 3)

	cases := []struct {
		name     string
		from, to string
		action   string
		strict   bool
		want     int
	}{
		{"upgrade RC3 -> 0.2.0-rc.1", rc3, rc1, "activate", false, exitOK},
		{"upgrade 0.2.0 -> 0.3.0", rc1, v03, "activate", false, exitOK},
		{"repair 0.2.0 -> 0.2.0", rc1, rc1, "activate", false, exitOK},
		// The Phase-6 release blocker: RC3 against schema-2 records.
		{"rollback 0.2.0-rc.1 -> RC3", rc1, rc3, "rollback", true, exitRelease},
		{"installing 0.2.0 over 0.3.0", v03, rc1, "activate", false, exitRelease},
		{"rollback 0.3.0 -> 0.2.0", v03, rc1, "rollback", true, exitRelease},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := guardDataGeneration(tree, c.from, c.to, c.action, c.strict); got != c.want {
				t.Fatalf("got exit %d, want %d", got, c.want)
			}
		})
	}
}

// An unreadable source release: a rollback refuses, an activation proceeds (it is the repair path), and
// an unreadable destination is refused by both.
func TestGuardWhenASchemaCannotBeRead(t *testing.T) {
	tree := layout.At(t.TempDir())
	fakeRelease(t, tree, rc1, 2)
	broken := "2026.09.28-win-broken"
	if err := os.MkdirAll(filepath.Join(tree.Releases(), broken, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := guardDataGeneration(tree, broken, rc1, "rollback", true); got != exitRelease {
		t.Errorf("rollback from an unreadable release: exit %d, want %d", got, exitRelease)
	}
	if got := guardDataGeneration(tree, broken, rc1, "activate", false); got != exitOK {
		t.Errorf("activation over an unreadable release: exit %d, want %d", got, exitOK)
	}
	if got := guardDataGeneration(tree, rc1, broken, "activate", false); got != exitRelease {
		t.Errorf("activating an unreadable release: exit %d, want %d", got, exitRelease)
	}
}
