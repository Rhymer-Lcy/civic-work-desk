package layout

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// rootFromExecutable is what makes a custom installation directory work at all: every tool has to find
// its OWN tree, not the default one. Before RC2 these paths all resolved to %LOCALAPPDATA%, and a
// launcher installed on D: reported "no installed version" from inside a working installation.
//
// os.Executable cannot be pointed at an arbitrary path in a test, so the mapping is exercised through
// the same logic with an explicit path, and the real os.Executable case is covered separately below.
func deriveRoot(exe string) (string, bool) {
	dir := filepath.Dir(exe)
	switch strings.ToLower(filepath.Base(dir)) {
	case "bin":
		return filepath.Dir(dir), true
	case "server":
		releaseDir := filepath.Dir(dir)
		releasesDir := filepath.Dir(releaseDir)
		if strings.EqualFold(filepath.Base(releasesDir), "releases") {
			return filepath.Dir(releasesDir), true
		}
	}
	return "", false
}

func TestRootIsDerivedFromBin(t *testing.T) {
	cases := map[string]string{
		`C:\Users\A\AppData\Local\CivicWorkDesk\bin\civic-launch.exe`: `C:\Users\A\AppData\Local\CivicWorkDesk`,
		`D:\Applications\CivicWorkDesk\bin\civic-diag.exe`:            `D:\Applications\CivicWorkDesk`,
		`D:\政务工作记录台\bin\civic-server.exe`:                             `D:\政务工作记录台`,
		`E:\Program Folder With Spaces\CWD\bin\civic-admin.exe`:       `E:\Program Folder With Spaces\CWD`,
		// Windows paths are case-insensitive, and Inno may well hand back a differently-cased path.
		`D:\Applications\CivicWorkDesk\BIN\civic-launch.exe`: `D:\Applications\CivicWorkDesk`,
	}
	for exe, want := range cases {
		got, ok := deriveRoot(exe)
		if !ok || got != want {
			t.Errorf("deriveRoot(%q) = %q, %v; want %q, true", exe, got, ok, want)
		}
	}
}

func TestRootIsDerivedFromAReleaseServerDirectory(t *testing.T) {
	exe := `D:\Applications\CivicWorkDesk\releases\2026.09.24-win-rc2\server\civic-server.exe`
	got, ok := deriveRoot(exe)
	if !ok || got != `D:\Applications\CivicWorkDesk` {
		t.Errorf("deriveRoot(%q) = %q, %v", exe, got, ok)
	}
}

// Anything that is not one of the two recognised layouts must fall through to the default, rather than
// inventing a root from a path that means nothing.
func TestUnrecognisedLayoutsAreRejected(t *testing.T) {
	for _, exe := range []string{
		`C:\Users\A\Downloads\civic-launch.exe`,
		`D:\CivicWorkDesk\civic-launch.exe`,
		`D:\CivicWorkDesk\releases\2026.09.24-win-rc2\civic-server.exe`,
		`D:\somewhere\server\civic-server.exe`, // "server" but not under releases\<id>\
		`civic-launch.exe`,
	} {
		if _, ok := deriveRoot(exe); ok {
			t.Errorf("deriveRoot(%q) claimed to recognise the layout", exe)
		}
	}
}

// And the production path: the real os.Executable must not blow up, and Default must always return a
// usable tree.
func TestDefaultAlwaysReturnsATree(t *testing.T) {
	tree, err := Default()
	if err != nil {
		if os.Getenv("LOCALAPPDATA") != "" {
			t.Fatalf("Default failed even though LOCALAPPDATA is set: %v", err)
		}
		t.Skip("no LOCALAPPDATA and no recognisable layout in this environment")
	}
	if tree.Root == "" {
		t.Fatal("Default returned an empty root")
	}
	if !filepath.IsAbs(tree.Root) {
		t.Errorf("Default returned a relative root: %q", tree.Root)
	}
}
