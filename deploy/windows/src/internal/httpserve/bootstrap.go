package httpserve

import (
	_ "embed"
	"fmt"
	"net/http"
)

// The update bootstrap (Phase 6): the page the launcher and the installer open instead of the
// application root. It lives under /api/, the one path the application's service worker never answers
// with the application shell, so it always comes from this server, and it decides -- with the browser,
// not by assumption -- whether the interface the browser would run at `/` is the one this release
// installed. The logic is in bootstrap/start.js; its header states the rules.
//
// The two files are embedded rather than served from the payload so that no release payload can
// shadow or alter them, and so that the acceptance suites load exactly these bytes.

//go:embed bootstrap/start.html
var bootstrapPage []byte

//go:embed bootstrap/start.js
var bootstrapScript []byte

// bootstrapPolicy allows the page its own script and style and its two same-origin requests (the
// runtime endpoint and /index.html), and nothing else: no inline script, no frames, no forms.
const bootstrapPolicy = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
	"connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func serveBootstrapPage(w http.ResponseWriter, r *http.Request) {
	serveEmbedded(w, r, bootstrapPage, "text/html; charset=utf-8", bootstrapPolicy)
}

func serveBootstrapScript(w http.ResponseWriter, r *http.Request) {
	serveEmbedded(w, r, bootstrapScript, "text/javascript; charset=utf-8", "")
}

// serveEmbedded answers GET and HEAD with a generated resource that must never be cached: an update
// decision made from a stale copy of the page itself would defeat its purpose.
func serveEmbedded(w http.ResponseWriter, r *http.Request, content []byte, contentType, policy string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if policy != "" {
		w.Header().Set("Content-Security-Policy", policy)
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(content)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(content)
	}
}
