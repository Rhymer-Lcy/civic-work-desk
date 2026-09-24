package httpserve

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture builds a document root plus a sibling directory and a secret one level above it, so an
// escape has something to find. A traversal test against an empty filesystem proves nothing: it
// would pass even if containment were broken.
func fixture(t *testing.T) (appDir string, cfg Config) {
	t.Helper()
	base := t.TempDir()
	appDir = filepath.Join(base, "release", "app")
	if err := os.MkdirAll(filepath.Join(appDir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(appDir, "icons"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(appDir, filepath.FromSlash(rel)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<!doctype html><title>app</title>")
	write("sw.js", "// service worker")
	write("manifest.webmanifest", `{"name":"app"}`)
	write("deployment-health.json", `{"releaseId":"2026.09.24-win-rc1"}`)
	write("assets/index-abc123.js", "export const x = 1;")
	write("assets/index-abc123.css", "body{}")
	write("icons/icon-192.png", "\x89PNG\r\n\x1a\n")

	// Two things outside the root that a successful escape would reach. The markers are deliberately
	// long and unique: an earlier revision of this test used "sibling", which is a substring of the
	// directory name "appsibling" and therefore matched a redirect body that had leaked nothing.
	if err := os.WriteFile(filepath.Join(base, "release", "SECRET.txt"),
		[]byte("CANARY-OUTSIDE-ROOT-MUST-NOT-LEAK"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(base, "release", "appsibling"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "release", "appsibling", "x.txt"),
		[]byte("CANARY-SIBLING-DIRECTORY-MUST-NOT-LEAK"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg = Config{
		AppDir: appDir,
		Health: Health{
			Application:     "civic-work-desk",
			Component:       "civic-server",
			ReleaseID:       "2026.09.24-win-rc1",
			InstallRoot:     base,
			AppDir:          appDir,
			CanonicalOrigin: "http://127.0.0.1:8765",
			PID:             4242,
		},
		ShutdownToken: "token-for-tests",
	}
	return appDir, cfg
}

// do issues a request for a raw target the way net/http would parse it off the wire, so the handler
// sees exactly what a hostile client would make it see.
//
// httptest.NewRequest panics on a target net/url refuses to represent at all (a NUL byte, for
// instance). That is itself a valid outcome -- the request can never reach a real server -- but the
// handler should still be exercised on the decoded form, so the fallback builds the URL directly.
func do(t *testing.T, h http.Handler, method, target string) *http.Response {
	t.Helper()
	var req *http.Request
	func() {
		defer func() {
			if recover() != nil {
				req = nil
			}
		}()
		req = httptest.NewRequest(method, target, nil)
	}()
	if req == nil {
		req = httptest.NewRequest(method, "http://127.0.0.1:8765/", nil)
		req.URL = &url.URL{Path: target}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func body(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRootServesIndex(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	if !strings.Contains(body(t, resp), "<title>app</title>") {
		t.Error("GET / did not serve index.html")
	}
}

func TestMIMETypes(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	cases := map[string]string{
		"/index.html":              "text/html; charset=utf-8",
		"/sw.js":                   "text/javascript; charset=utf-8",
		"/assets/index-abc123.js":  "text/javascript; charset=utf-8",
		"/assets/index-abc123.css": "text/css; charset=utf-8",
		"/manifest.webmanifest":    "application/manifest+json; charset=utf-8",
		"/deployment-health.json":  "application/json; charset=utf-8",
		"/icons/icon-192.png":      "image/png",
	}
	for path, want := range cases {
		resp := do(t, h, http.MethodGet, path)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, resp.StatusCode)
			continue
		}
		if got := resp.Header.Get("Content-Type"); got != want {
			t.Errorf("GET %s Content-Type = %q, want %q", path, got, want)
		}
		if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("GET %s missing nosniff (got %q)", path, got)
		}
	}
}

// The registry is the reason the MIME table is hard-coded. Prove the table, not the platform: a
// value that came from mime.TypeByExtension would vary by machine.
func TestJavaScriptIsNeverTextPlain(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	for _, p := range []string{"/sw.js", "/assets/index-abc123.js"} {
		resp := do(t, h, http.MethodGet, p)
		if ct := resp.Header.Get("Content-Type"); strings.HasPrefix(ct, "text/plain") {
			t.Fatalf("GET %s served as %q; a module script served as text/plain is refused by every browser", p, ct)
		}
	}
}

func TestHeadIsServedWithoutBody(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodHead, "/index.html")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HEAD /index.html = %d, want 200", resp.StatusCode)
	}
	if got := body(t, resp); got != "" {
		t.Errorf("HEAD returned a %d-byte body", len(got))
	}
	if resp.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Error("HEAD lost the content type")
	}
}

func TestUnsafeMethodsRejected(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete,
		http.MethodPatch, http.MethodOptions, "TRACE"} {
		resp := do(t, h, m, "/index.html")
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s /index.html = %d, want 405", m, resp.StatusCode)
		}
		if got := resp.Header.Get("Allow"); got != "GET, HEAD" {
			t.Errorf("%s: Allow = %q, want \"GET, HEAD\"", m, got)
		}
	}
}

func TestNoDirectoryListing(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	for _, p := range []string{"/assets/", "/assets", "/icons/", "/icons"} {
		resp := do(t, h, http.MethodGet, p)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", p, resp.StatusCode)
		}
		b := body(t, resp)
		if strings.Contains(b, "index-abc123.js") || strings.Contains(b, "icon-192.png") {
			t.Errorf("GET %s leaked a directory listing: %q", p, b)
		}
	}
}

// The table is the adversarial core. Every entry is a shape that has been used against a static
// server in the wild; a single 200 with the secret's contents here is a breach.
func TestTraversalRejected(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	targets := []string{
		"/../SECRET.txt",
		"/../../SECRET.txt",
		"/assets/../../SECRET.txt",
		"/./../SECRET.txt",
		"/%2e%2e/SECRET.txt",
		"/%2e%2e%2fSECRET.txt",
		"/%2E%2E%2FSECRET.txt",
		"/%252e%252e%252fSECRET.txt",
		"/..%2fSECRET.txt",
		"/..%5cSECRET.txt",
		`/..\SECRET.txt`,
		`/\..\SECRET.txt`,
		`/assets\..\..\SECRET.txt`,
		"/....//SECRET.txt",
		"/.%2e/SECRET.txt",
		"//SECRET.txt",
		"/index.html/../SECRET.txt",
		"/%00/SECRET.txt",
		"/index.html%00.js",
		"/../appsibling/x.txt",
		"/..%2fappsibling%2fx.txt",
		"/C:/Windows/win.ini",
		"/index.html.",
		"/index.html ",
		"/assets/./../../SECRET.txt",
	}
	for _, target := range targets {
		resp := do(t, h, http.MethodGet, target)
		got := body(t, resp)
		if strings.Contains(got, "CANARY-OUTSIDE-ROOT-MUST-NOT-LEAK") {
			t.Fatalf("GET %s LEAKED the file outside the document root (status %d)", target, resp.StatusCode)
		}
		if strings.Contains(got, "CANARY-SIBLING-DIRECTORY-MUST-NOT-LEAK") {
			t.Fatalf("GET %s reached the sibling directory (status %d)", target, resp.StatusCode)
		}
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusNotFound &&
			resp.StatusCode != http.StatusMovedPermanently && resp.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s = %d; want a refusal (400/404), not this", target, resp.StatusCode)
		}
	}
}

// The traversal table must be able to fail, or its 25 passes mean nothing. Point a handler at the
// parent directory and confirm the same request that is refused above now succeeds -- proving the
// refusals come from containment and not from the files being absent.
func TestTraversalTestCanFail(t *testing.T) {
	appDir, cfg := fixture(t)
	parent := filepath.Dir(appDir)
	cfg.AppDir = parent
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/SECRET.txt")
	if !strings.Contains(body(t, resp), "CANARY-OUTSIDE-ROOT-MUST-NOT-LEAK") {
		t.Fatal("the fixture's secret is unreachable even from its own directory; the traversal test could not have failed")
	}
}

func TestResolveRejectionsAreExplicit(t *testing.T) {
	appDir, _ := fixture(t)
	cases := []struct {
		path string
		code int
	}{
		{"/index.html", http.StatusOK},
		{"/", http.StatusOK},
		{"/../x", http.StatusBadRequest},
		{`/a\b`, http.StatusBadRequest},
		{"/a\x00b", http.StatusBadRequest},
		{"relative", http.StatusBadRequest},
		{"/a:b", http.StatusBadRequest},
		{"/a?b", http.StatusBadRequest},
		{"/a|b", http.StatusBadRequest},
		{"/trailing.", http.StatusBadRequest},
		{"/trailing ", http.StatusBadRequest},
	}
	for _, c := range cases {
		_, code, why := resolve(appDir, c.path)
		if code != c.code {
			t.Errorf("resolve(%q) = %d (%s), want %d", c.path, code, why, c.code)
		}
	}
}

func TestReservedNamespaceHealth(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/__civic/health")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health = %d, want 200", resp.StatusCode)
	}
	var got Health
	if err := json.Unmarshal([]byte(body(t, resp)), &got); err != nil {
		t.Fatalf("health is not JSON: %v", err)
	}
	if got.ReleaseID != "2026.09.24-win-rc1" {
		t.Errorf("health releaseId = %q", got.ReleaseID)
	}
	if got.CanonicalOrigin != "http://127.0.0.1:8765" {
		t.Errorf("health canonicalOrigin = %q", got.CanonicalOrigin)
	}
	if got.Component != "civic-server" {
		t.Errorf("health component = %q", got.Component)
	}
}

func TestReservedNamespaceUnknownIs404(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/__civic/nope")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("/__civic/nope = %d, want 404", resp.StatusCode)
	}
}

func TestPlatformPageIsSelfContained(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/__civic/platform")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("platform page = %d, want 200", resp.StatusCode)
	}
	page := body(t, resp)
	if !strings.Contains(page, "http://127.0.0.1:8765") {
		t.Error("platform page does not carry the expected origin")
	}
	if !strings.Contains(page, "2026.09.24-win-rc1") {
		t.Error("platform page does not carry the release id")
	}
	// It must not pull anything from the network, and must not register a service worker of its own.
	for _, forbidden := range []string{"http://", "https://", "serviceWorker.register", "//cdn"} {
		if forbidden == "http://" {
			// The expected origin is legitimately an http:// string; count the others.
			continue
		}
		if strings.Contains(page, forbidden) {
			t.Errorf("platform page contains %q", forbidden)
		}
	}
	if strings.Count(page, "https://") != 0 {
		t.Error("platform page references an https:// resource")
	}
}

func TestShutdownRequiresPostAndToken(t *testing.T) {
	_, cfg := fixture(t)
	called := 0
	cfg.Shutdown = func() { called++ }
	h := Handler(cfg)

	// Wrong method.
	resp := do(t, h, http.MethodGet, "/__civic/shutdown")
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET shutdown = %d, want 405", resp.StatusCode)
	}

	// Right method, no token.
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/__civic/shutdown", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST shutdown without token = %d, want 403", rec.Code)
	}

	// Right method, wrong token.
	req = httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/__civic/shutdown", nil)
	req.Header.Set("X-Civic-Token", "wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST shutdown with wrong token = %d, want 403", rec.Code)
	}
	if called != 0 {
		t.Fatalf("shutdown ran %d time(s) without a valid token", called)
	}

	// Correct.
	req = httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/__civic/shutdown", nil)
	req.Header.Set("X-Civic-Token", "token-for-tests")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("POST shutdown with the token = %d, want 200", rec.Code)
	}
}

func TestShutdownDisabledWhenNoCallback(t *testing.T) {
	_, cfg := fixture(t)
	cfg.Shutdown = nil
	h := Handler(cfg)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8765/__civic/shutdown", nil)
	req.Header.Set("X-Civic-Token", "token-for-tests")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("shutdown with no callback = %d, want 404", rec.Code)
	}
}

func TestCacheControl(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	cases := map[string]string{
		"/index.html":              "no-cache",
		"/sw.js":                   "no-cache",
		"/manifest.webmanifest":    "no-cache",
		"/assets/index-abc123.js":  "public, max-age=31536000, immutable",
		"/assets/index-abc123.css": "public, max-age=31536000, immutable",
	}
	for p, want := range cases {
		resp := do(t, h, http.MethodGet, p)
		if got := resp.Header.Get("Cache-Control"); got != want {
			t.Errorf("GET %s Cache-Control = %q, want %q", p, got, want)
		}
	}
}

// A service worker whose script is cached hard cannot ship an update. This is the specific mistake
// the cacheControlFor split exists to prevent, so pin it separately from the table above.
func TestServiceWorkerScriptIsNotImmutable(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/sw.js")
	if strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Fatal("sw.js is served immutable; an update could never be picked up")
	}
}

func TestLoggingIsPrivacyMinimal(t *testing.T) {
	_, cfg := fixture(t)
	var logged []string
	cfg.Log = func(s string) { logged = append(logged, s) }
	h := Handler(cfg)

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/index.html?secret=value", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 UNIQUE-AGENT-STRING")
	req.Header.Set("Cookie", "session=UNIQUE-COOKIE")
	req.Header.Set("Referer", "http://127.0.0.1:8765/UNIQUE-REFERER")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if len(logged) == 0 {
		t.Fatal("nothing was logged")
	}
	all := strings.Join(logged, "\n")
	for _, forbidden := range []string{"UNIQUE-AGENT-STRING", "UNIQUE-COOKIE", "UNIQUE-REFERER", "secret=value"} {
		if strings.Contains(all, forbidden) {
			t.Errorf("the log carries %q", forbidden)
		}
	}
	if !strings.Contains(all, "GET /index.html -> 200") {
		t.Errorf("the log does not carry the request outcome: %q", all)
	}
}

func TestUnknownExtensionIsOpaque(t *testing.T) {
	appDir, cfg := fixture(t)
	if err := os.WriteFile(filepath.Join(appDir, "thing.xyz"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	var logged []string
	cfg.Log = func(s string) { logged = append(logged, s) }
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/thing.xyz")
	if got := resp.Header.Get("Content-Type"); got != "application/octet-stream" {
		t.Errorf("unknown extension served as %q, want application/octet-stream", got)
	}
	if !strings.Contains(strings.Join(logged, "\n"), "no content type") {
		t.Error("an unknown extension was served without a warning in the log")
	}
}

func TestMissingFileIs404(t *testing.T) {
	_, cfg := fixture(t)
	h := Handler(cfg)
	resp := do(t, h, http.MethodGet, "/nope.js")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET /nope.js = %d, want 404", resp.StatusCode)
	}
}

func TestContentTypeForCoversThePayload(t *testing.T) {
	// Every extension in the validated UOS payload must be known, or the Windows deployment would
	// serve the same bytes with a different type from the platform that was field-validated.
	for _, ext := range []string{".js", ".png", ".webmanifest", ".svg", ".json", ".html", ".css"} {
		if _, ok := ContentTypeFor("x" + ext); !ok {
			t.Errorf("%s is in the validated payload but has no content type", ext)
		}
	}
}
