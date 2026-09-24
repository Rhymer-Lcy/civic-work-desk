package release

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func digest(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// stage builds a release directory whose manifest is correct, so each test can break exactly one thing.
func stage(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"app/index.html":          "<!doctype html>",
		"app/sw.js":               "// sw",
		"app/assets/index-abc.js": "export const a = 1;",
		"server/civic-server.exe": "MZ-not-really",
	}
	var manifest strings.Builder
	for rel, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Written in a fixed order so the manifest text is stable across runs.
	for _, rel := range []string{"app/assets/index-abc.js", "app/index.html", "app/sw.js", "server/civic-server.exe"} {
		fmt.Fprintf(&manifest, "%s  %s\n", digest(files[rel]), rel)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, VersionName),
		[]byte("CivicWorkDesk Windows release\nreleaseId=2026.09.24-win-rc1\nappVersion=0.1.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestVerifyCleanRelease(t *testing.T) {
	dir := stage(t)
	res, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK() {
		t.Fatalf("a correct release did not verify: %s", res.Summary())
	}
	if res.Checked != 4 {
		t.Errorf("checked %d files, want 4", res.Checked)
	}
	if !strings.Contains(res.Summary(), "4 file(s) verified") {
		t.Errorf("summary does not state the count: %q", res.Summary())
	}
}

func TestVerifyDetectsAlteredFile(t *testing.T) {
	dir := stage(t)
	if err := os.WriteFile(filepath.Join(dir, "app", "sw.js"), []byte("// tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK() {
		t.Fatal("an altered file verified clean")
	}
	if len(res.Mismatch) != 1 || res.Mismatch[0] != "app/sw.js" {
		t.Errorf("mismatch = %v, want [app/sw.js]", res.Mismatch)
	}
}

func TestVerifyDetectsMissingFile(t *testing.T) {
	dir := stage(t)
	if err := os.Remove(filepath.Join(dir, "app", "index.html")); err != nil {
		t.Fatal(err)
	}
	res, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK() {
		t.Fatal("a missing file verified clean")
	}
	if len(res.Missing) != 1 || res.Missing[0] != "app/index.html" {
		t.Errorf("missing = %v, want [app/index.html]", res.Missing)
	}
}

// The check that a one-directional audit cannot make. An unlisted file inside the document root is how
// a stray script or a leftover from an earlier release ends up being served, and "every manifest entry
// is present and correct" stays true the whole time.
func TestVerifyDetectsUnlistedFile(t *testing.T) {
	dir := stage(t)
	if err := os.WriteFile(filepath.Join(dir, "app", "extra.js"), []byte("// nobody listed me"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK() {
		t.Fatal("an unlisted file inside the payload verified clean")
	}
	if len(res.Unlisted) != 1 || res.Unlisted[0] != "app/extra.js" {
		t.Errorf("unlisted = %v, want [app/extra.js]", res.Unlisted)
	}
}

func TestVerifyIgnoresTheManifestAndVersion(t *testing.T) {
	dir := stage(t)
	res, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range res.Unlisted {
		if name == ManifestName || name == VersionName {
			t.Errorf("%s was reported as unlisted; the manifest does not describe itself", name)
		}
	}
}

// Manifest paths are attacker-shaped input as soon as a release can come from anywhere. Verifying a
// manifest that names ..\..\Windows\win.ini would turn integrity checking into an arbitrary-file read.
func TestReadManifestRejectsDangerousPaths(t *testing.T) {
	cases := map[string]string{
		"parent segment":  digest("x") + "  ../outside.txt\n",
		"nested parent":   digest("x") + "  app/../../outside.txt\n",
		"backslash":       digest("x") + `  app\index.html` + "\n",
		"absolute posix":  digest("x") + "  /etc/passwd\n",
		"absolute drive":  digest("x") + "  C:/Windows/win.ini\n",
		"short digest":    "abc  app/index.html\n",
		"non-hex digest":  strings.Repeat("z", 64) + "  app/index.html\n",
		"no path":         digest("x") + "  \n",
		"duplicate entry": digest("x") + "  app/a.js\n" + digest("y") + "  app/a.js\n",
	}
	for name, body := range cases {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadManifest(dir); err == nil {
			t.Errorf("%s: ReadManifest accepted %q", name, strings.TrimSpace(body))
		}
	}
}

func TestReadManifestAcceptsSha256sumFormats(t *testing.T) {
	dir := t.TempDir()
	// Both the text form (two spaces) and the binary form (space-star) that sha256sum writes.
	body := digest("a") + "  app/a.js\n" + digest("b") + " *app/b.js\n" +
		"# a comment\n" + "\n"
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := ReadManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[1].Path != "app/b.js" {
		t.Errorf("the binary-form path was parsed as %q", entries[1].Path)
	}
}

func TestReadManifestRejectsEmptyManifest(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte("# nothing but a comment\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadManifest(dir); err == nil {
		t.Error("a manifest listing no files was accepted; it would make Verify pass on an empty payload")
	}
}

func TestReadVersion(t *testing.T) {
	dir := stage(t)
	v, err := ReadVersion(dir)
	if err != nil {
		t.Fatal(err)
	}
	if v.Get("releaseId") != "2026.09.24-win-rc1" {
		t.Errorf("releaseId = %q", v.Get("releaseId"))
	}
	if v.Get("appVersion") != "0.1.0" {
		t.Errorf("appVersion = %q", v.Get("appVersion"))
	}
	if v.Get("absent") != "" {
		t.Error("an absent key returned something")
	}
	if len(v.Keys) != 2 {
		t.Errorf("Keys = %v, want the two pairs (the title line is not a pair)", v.Keys)
	}
}

func TestFileDigestMatchesKnownValue(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x.txt")
	if err := os.WriteFile(p, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := FileDigest(p)
	if err != nil {
		t.Fatal(err)
	}
	// The published SHA-256 of "abc". A digest function checked only against itself proves nothing.
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != want {
		t.Errorf("FileDigest = %q, want %q", got, want)
	}
}
