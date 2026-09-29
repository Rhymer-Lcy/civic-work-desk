package httpserve

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The browser-facing endpoints under /api/civic/ (Phase 6): the update bootstrap, the runtime
// generation and the platform check. They must be answered by this server even while the application's
// service worker controls the origin, never be cached, and never fall through to a file on disk.

// withGeneration makes the fixture a release that knows its interface generation: an index.html that
// loads the entry script, and an app-generation.json that names it.
func withGeneration(t *testing.T, appDir string) {
	t.Helper()
	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(appDir, filepath.FromSlash(rel)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", `<!doctype html><script type="module" crossorigin src="./assets/index-abc123XY.js"></script>`)
	write("assets/index-abc123XY.js", "export {};")
	write("app-generation.json",
		`{"schema":"civic-app-generation/1","appGeneration":"ui-abc123XY","entry":"assets/index-abc123XY.js"}`)
}

func TestRuntimeAnswersTheActiveReleaseGeneration(t *testing.T) {
	appDir, cfg := fixture(t)
	withGeneration(t, appDir)
	h := Handler(cfg)

	resp := do(t, h, http.MethodGet, "/api/civic/runtime")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("runtime = %d, want 200: %s", resp.StatusCode, body(t, resp))
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var answer map[string]any
	if err := json.Unmarshal([]byte(body(t, resp)), &answer); err != nil {
		t.Fatalf("runtime is not JSON: %v", err)
	}
	want := map[string]any{
		"schema":          "civic-runtime/1",
		"appGeneration":   "ui-abc123XY",
		"releaseId":       "2026.09.24-win-rc1",
		"canonicalOrigin": "http://127.0.0.1:8765",
	}
	if len(answer) != len(want) {
		t.Errorf("runtime answer has fields %v, want exactly %v", answer, want)
	}
	for key, value := range want {
		if answer[key] != value {
			t.Errorf("runtime %s = %v, want %v", key, answer[key], value)
		}
	}

	head := do(t, h, http.MethodHead, "/api/civic/runtime")
	if head.StatusCode != http.StatusOK || body(t, head) != "" {
		t.Errorf("HEAD runtime = %d with a body", head.StatusCode)
	}
	if post := do(t, h, http.MethodPost, "/api/civic/runtime"); post.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST runtime = %d, want 405", post.StatusCode)
	}
}

func TestRuntimeFailsClosed(t *testing.T) {
	cases := []struct {
		name    string
		prepare func(t *testing.T, appDir string)
		reason  string
	}{
		{"file missing", func(t *testing.T, appDir string) {
			if err := os.Remove(filepath.Join(appDir, "app-generation.json")); err != nil {
				t.Fatal(err)
			}
		}, "missing"},
		{"not JSON", func(t *testing.T, appDir string) {
			writeFile(t, appDir, "app-generation.json", "ui-abc123XY")
		}, "not the expected JSON"},
		{"an unknown field", func(t *testing.T, appDir string) {
			writeFile(t, appDir, "app-generation.json",
				`{"schema":"civic-app-generation/1","appGeneration":"ui-abc123XY","entry":"assets/index-abc123XY.js","extra":1}`)
		}, "not the expected JSON"},
		{"another schema", func(t *testing.T, appDir string) {
			writeFile(t, appDir, "app-generation.json",
				`{"schema":"civic-app-generation/2","appGeneration":"ui-abc123XY","entry":"assets/index-abc123XY.js"}`)
		}, "schema"},
		{"generation and entry disagree", func(t *testing.T, appDir string) {
			writeFile(t, appDir, "app-generation.json",
				`{"schema":"civic-app-generation/1","appGeneration":"ui-OTHER999","entry":"assets/index-abc123XY.js"}`)
		}, "do not match"},
		{"a malformed generation", func(t *testing.T, appDir string) {
			writeFile(t, appDir, "app-generation.json",
				`{"schema":"civic-app-generation/1","appGeneration":"<script>","entry":"assets/index-abc123XY.js"}`)
		}, "do not match"},
		{"the entry script is absent", func(t *testing.T, appDir string) {
			if err := os.Remove(filepath.Join(appDir, "assets", "index-abc123XY.js")); err != nil {
				t.Fatal(err)
			}
		}, "not in the release"},
		{"index.html loads another script", func(t *testing.T, appDir string) {
			writeFile(t, appDir, "index.html", `<script type="module" src="./assets/index-abc123.js"></script>`)
		}, "does not load"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			appDir, cfg := fixture(t)
			withGeneration(t, appDir)
			tc.prepare(t, appDir)
			resp := do(t, Handler(cfg), http.MethodGet, "/api/civic/runtime")
			text := body(t, resp)
			if resp.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("runtime = %d, want 503: %s", resp.StatusCode, text)
			}
			if resp.Header.Get("Cache-Control") != "no-store" {
				t.Error("a refusal must not be cached either")
			}
			var answer map[string]any
			if err := json.Unmarshal([]byte(text), &answer); err != nil {
				t.Fatalf("refusal is not JSON: %v", err)
			}
			if _, ok := answer["appGeneration"]; ok {
				t.Errorf("a refusal names a generation: %v", answer)
			}
			if answer["schema"] != "civic-runtime/1" {
				t.Errorf("refusal schema = %v", answer["schema"])
			}
			if reason, _ := answer["error"].(string); !strings.Contains(reason, tc.reason) {
				t.Errorf("refusal reason %q does not say %q", reason, tc.reason)
			}
			// The reason reaches the browser: it may name a file, never where the release is installed
			// (under %LOCALAPPDATA% that path names the Windows user).
			if reason, _ := answer["error"].(string); strings.Contains(reason, filepath.Dir(appDir)) ||
				strings.Contains(reason, ":\\") || strings.Contains(reason, string(filepath.Separator)+"app") {
				t.Errorf("refusal reason %q discloses a path", reason)
			}
		})
	}
}

func writeFile(t *testing.T, appDir, rel, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(appDir, filepath.FromSlash(rel)), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBootstrapPageIsServedByThisServerAndNeverCached(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)

	page := do(t, h, http.MethodGet, "/api/civic/start")
	html := body(t, page)
	if page.StatusCode != http.StatusOK {
		t.Fatalf("start = %d, want 200", page.StatusCode)
	}
	for header, want := range map[string]string{
		"Content-Type":            "text/html; charset=utf-8",
		"Cache-Control":           "no-store",
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": bootstrapPolicy,
	} {
		if got := page.Header.Get(header); got != want {
			t.Errorf("start %s = %q, want %q", header, got, want)
		}
	}
	onDisk, err := os.ReadFile(filepath.Join("bootstrap", "start.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal([]byte(html), onDisk) {
		t.Error("the served page is not bootstrap/start.html")
	}
	// No inline script: the policy allows only 'self', so the page's only script is the external one.
	scripts := regexp.MustCompile(`(?s)<script([^>]*)>(.*?)</script>`).FindAllStringSubmatch(html, -1)
	if len(scripts) != 1 || !strings.Contains(scripts[0][1], `src="/api/civic/start.js"`) ||
		strings.TrimSpace(scripts[0][2]) != "" {
		t.Errorf("the page must load exactly /api/civic/start.js and nothing inline, got %q", scripts)
	}

	script := do(t, h, http.MethodGet, "/api/civic/start.js")
	js := body(t, script)
	if script.StatusCode != http.StatusOK ||
		script.Header.Get("Content-Type") != "text/javascript; charset=utf-8" ||
		script.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("start.js = %d %q %q", script.StatusCode, script.Header.Get("Content-Type"),
			script.Header.Get("Cache-Control"))
	}
	jsOnDisk, err := os.ReadFile(filepath.Join("bootstrap", "start.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal([]byte(js), jsOnDisk) {
		t.Error("the served script is not bootstrap/start.js")
	}
	// Nothing from the network, and nothing destructive.
	for _, forbidden := range []string{
		"http://", "https://", "indexedDB", "caches.delete", ".unregister(", "localStorage",
		"serviceWorker.register",
	} {
		if strings.Contains(html, forbidden) || strings.Contains(js, forbidden) {
			t.Errorf("the bootstrap contains %q", forbidden)
		}
	}
	if post := do(t, h, http.MethodPost, "/api/civic/start"); post.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST start = %d, want 405", post.StatusCode)
	}
}

func TestPlatformCheckMovedUnderAPI(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/api/civic/platform")
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("platform = %d %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	if strings.Contains(body(t, resp), "/__civic/platform") {
		t.Error("the platform page still names its old address")
	}
	legacy := do(t, h, http.MethodGet, "/__civic/platform")
	if legacy.StatusCode != http.StatusFound || legacy.Header.Get("Location") != "/api/civic/platform" {
		t.Errorf("legacy platform = %d -> %q, want 302 -> /api/civic/platform",
			legacy.StatusCode, legacy.Header.Get("Location"))
	}
	if legacy.Header.Get("Cache-Control") != "no-store" {
		t.Error("the legacy redirect must not be cached")
	}
}

func TestAPINamespaceIsNeverReadFromDisk(t *testing.T) {
	appDir, cfg := fixture(t)
	if err := os.MkdirAll(filepath.Join(appDir, "api", "civic"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, appDir, "api/civic/runtime", "SHADOW-MUST-NOT-BE-SERVED")
	writeFile(t, appDir, "api/civic/extra.json", "SHADOW-MUST-NOT-BE-SERVED")
	h := Handler(cfg)
	for _, target := range []string{"/api/civic/extra.json", "/api/other", "/api/"} {
		resp := do(t, h, http.MethodGet, target)
		if resp.StatusCode != http.StatusNotFound || strings.Contains(body(t, resp), "SHADOW") {
			t.Errorf("%s = %d; the /api/ namespace must never fall through to a file", target, resp.StatusCode)
		}
	}
	// The generated endpoint wins over a file of the same name.
	if text := body(t, do(t, h, http.MethodGet, "/api/civic/runtime")); strings.Contains(text, "SHADOW") {
		t.Error("a payload file shadowed /api/civic/runtime")
	}
}
