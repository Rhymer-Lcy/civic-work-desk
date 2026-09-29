package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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

	// A release that cannot state its interface generation is not activated.
	dir := servableRelease(t)
	if err := os.Remove(filepath.Join(dir, "app", "app-generation.json")); err != nil {
		t.Fatal(err)
	}
	if status, _ := statusOf(payloadServableChecks(dir), generation); status != "FAIL" {
		t.Errorf("missing app-generation.json: generation = %s, want FAIL", status)
	}
}
