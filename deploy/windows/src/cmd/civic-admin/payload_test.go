package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/release"
)

// servableRelease writes a release whose payload the server can serve: an index.html that loads its entry
// script, an app-generation.json naming it, and a manifest listing those files plus any extra paths.
func servableRelease(t *testing.T, extra ...string) string {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("app/index.html", `<script type="module" src="./assets/index-abc123XY.js"></script>`)
	write("app/assets/index-abc123XY.js", "export {};")
	write("app/app-generation.json",
		`{"schema":"civic-app-generation/1","appGeneration":"ui-abc123XY","entry":"assets/index-abc123XY.js"}`)
	paths := append([]string{"app/index.html", "app/assets/index-abc123XY.js", "app/app-generation.json"}, extra...)
	var manifest strings.Builder
	for _, p := range paths {
		manifest.WriteString(strings.Repeat("a", 64) + " *" + p + "\n")
	}
	write("SHA256SUMS.txt", manifest.String())
	return dir
}

func statusOf(checks []check, name string) (string, string) {
	for _, c := range checks {
		if c.Name == name {
			return c.Status, c.Detail
		}
	}
	return "ABSENT", ""
}

func TestPayloadServableChecks(t *testing.T) {
	const shadow = "no file shadows /__civic/ or /api/"
	const generation = "interface generation"

	clean := payloadServableChecks(servableRelease(t))
	for _, c := range clean {
		if c.blocking() {
			t.Errorf("a servable release is blocked: %s", c)
		}
	}
	if status, detail := statusOf(clean, generation); status != "PASS" || detail != "ui-abc123XY" {
		t.Errorf("generation = %s %q, want PASS ui-abc123XY", status, detail)
	}
	if status, _ := statusOf(clean, shadow); status != "PASS" {
		t.Errorf("shadow check = %s, want PASS", status)
	}

	// Both reserved namespaces. Until Phase 6 the check built "//__civic/..." from "app/__civic/...", so a
	// shadowing file could never be detected; these two cases would have passed it.
	for _, bad := range []string{"app/__civic/health", "app/api/civic/runtime"} {
		checks := payloadServableChecks(servableRelease(t, bad))
		if status, detail := statusOf(checks, shadow); status != "FAIL" || !strings.Contains(detail, bad) {
			t.Errorf("%s: shadow check = %s %q, want FAIL naming it", bad, status, detail)
		}
	}

	// These checks also judge the release an upgrade REPLACES. RC3 and earlier have no
	// app-generation.json, and blocking on that stopped every upgrade from RC3 (the first 0.2.0 rehearsal
	// build): absence is reported, never blocking.
	dir := servableRelease(t)
	if err := os.Remove(filepath.Join(dir, "app", "app-generation.json")); err != nil {
		t.Fatal(err)
	}
	older := payloadServableChecks(dir)
	if status, _ := statusOf(older, generation); status != "NOT PRESENT" {
		t.Errorf("missing app-generation.json: generation = %s, want NOT PRESENT", status)
	}
	for _, c := range older {
		if c.blocking() {
			t.Errorf("an RC3-shaped release blocks the preflight: %s", c)
		}
	}

	// A file that is present but wrong is a damaged release, and that does block.
	damaged := servableRelease(t)
	if err := os.WriteFile(filepath.Join(damaged, "app", "app-generation.json"),
		[]byte(`{"schema":"civic-app-generation/1","appGeneration":"ui-zzzzzzzz","entry":"assets/index-zzzzzzzz.js"}`),
		0o644); err != nil {
		t.Fatal(err)
	}
	if status, _ := statusOf(payloadServableChecks(damaged), generation); status != "FAIL" {
		t.Errorf("damaged app-generation.json: generation = %s, want FAIL", status)
	}
}

// verifiedRelease writes a release that passes the shape assertion and its own manifest, optionally
// without app-generation.json, into tree.
func verifiedRelease(t *testing.T, tree layout.Tree, id string, withGeneration bool) string {
	t.Helper()
	dir := filepath.Join(tree.Releases(), id)
	files := map[string]string{
		"app/index.html":               `<script type="module" src="./assets/index-abc123XY.js"></script>`,
		"app/assets/index-abc123XY.js": "export {};",
		"server/civic-server.exe":      "not a real executable",
	}
	if withGeneration {
		files["app/app-generation.json"] =
			`{"schema":"civic-app-generation/1","appGeneration":"ui-abc123XY","entry":"assets/index-abc123XY.js"}`
	}
	var manifest strings.Builder
	for rel, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(content))
		manifest.WriteString(hex.EncodeToString(sum[:]) + " *" + rel + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS.txt"), []byte(manifest.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "VERSION"), []byte("releaseId="+id+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestActivationRequiresAnInterfaceGeneration(t *testing.T) {
	tree := layout.At(t.TempDir())
	id := "2026.09.30-win-0.2.0-rc.1"
	dir := verifiedRelease(t, tree, id, false)
	if err := tree.AssertReleaseShape(id); err != nil {
		t.Fatalf("fixture has the wrong shape: %v", err)
	}
	if res, err := release.Verify(dir); err != nil || !res.OK() {
		t.Fatalf("fixture does not verify: %v %s", err, res.Summary())
	}
	if _, err := requireInterfaceGeneration(dir); err == nil {
		t.Fatal("a release without app-generation.json was accepted")
	}

	// The refusal comes before anything is stopped, installed or repointed.
	if got := cmdActivate(tree, id); got != exitRelease {
		t.Fatalf("cmdActivate = %d, want %d", got, exitRelease)
	}
	for _, left := range []string{tree.CurrentFile(), filepath.Join(tree.Root, "bin", serverExeName)} {
		if _, err := os.Stat(left); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("a refused activation left %s behind (err %v)", left, err)
		}
	}

	with := verifiedRelease(t, layout.At(t.TempDir()), id, true)
	if gen, err := requireInterfaceGeneration(with); err != nil || gen != "ui-abc123XY" {
		t.Errorf("a release with its generation: %q, %v", gen, err)
	}
}
