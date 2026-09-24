// Package httpserve is the static file server for the CivicWorkDesk PWA payload.
//
// It exists because the browser storage that holds a user's records is bound to an origin -- scheme,
// host and port -- so the application must always be reached at exactly http://127.0.0.1:8765/. A
// file:// URL is a different origin with no storage, and a different port is a different origin with
// different storage. That invariant, not a preference for HTTP, is why there is a server here at all.
//
// ## What it does not do
//
// No directory listing. No SPA fallback -- the application does not use history routing, and adding a
// fallback would make this server behave differently from the BusyBox httpd that was actually
// validated on the UOS target. No upload, no write, no proxy, no TLS, no authentication: there is
// nothing to authenticate, because the listener is loopback-only and every byte served is a public
// build artefact.
//
// ## Why the MIME table is written out
//
// Go's mime.TypeByExtension consults the Windows registry, where HKCR\.js is routinely set to
// text/plain by other software. A module script served as text/plain is refused by every browser,
// and the failure is remote from its cause. The table below is the whole truth about content types
// for this payload; the registry is never asked.
package httpserve

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// ReservedPrefix is the namespace for endpoints this server generates rather than reads off disk.
// civic-admin verify asserts no payload file can ever live under it, so a release can never shadow
// the health endpoint.
const ReservedPrefix = "/__civic/"

// contentTypes is exhaustive for the payload. An extension outside it is served as an opaque
// download rather than guessed at, and `civic-admin verify` refuses to activate a release that
// contains one -- so in practice this map is complete by construction, not by hope.
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".map":         "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/vnd.microsoft.icon",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".webp":        "image/webp",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".wasm":        "application/wasm",
	".txt":         "text/plain; charset=utf-8",
}

// ContentTypeFor returns the type for a path, and whether it was known.
func ContentTypeFor(name string) (string, bool) {
	ct, ok := contentTypes[strings.ToLower(filepath.Ext(name))]
	if !ok {
		return "application/octet-stream", false
	}
	return ct, true
}

// KnownExtensions lists the extensions the server will serve with a real content type.
func KnownExtensions() []string {
	out := make([]string, 0, len(contentTypes))
	for ext := range contentTypes {
		out = append(out, ext)
	}
	return out
}

// Health is what /__civic/health returns. It answers "which server process, from which installation,
// owns this port" -- a question the payload's own deployment-health.json cannot answer, because the
// payload does not know where it was installed or who is serving it.
//
// Deliberately carries no user data, no environment, no paths outside the installation, and no
// account name beyond what the install path already contains.
type Health struct {
	Application     string `json:"application"`
	Component       string `json:"component"`
	ReleaseID       string `json:"releaseId"`
	InstallRoot     string `json:"installRoot"`
	AppDir          string `json:"appDir"`
	CanonicalOrigin string `json:"canonicalOrigin"`
	PID             int    `json:"pid"`
	ExePath         string `json:"exePath"`
	StartedAt       string `json:"startedAt"`
	ServerVersion   string `json:"serverVersion"`
}

// Logger receives one line per request. Kept as a function so the server package has no opinion
// about where logs go and the tests can capture them.
type Logger func(string)

// Config is everything the handler needs.
type Config struct {
	AppDir        string
	Health        Health
	Log           Logger
	ShutdownToken string
	// Shutdown is called when an authenticated shutdown request arrives. Nil disables the endpoint.
	Shutdown func()
}

// Handler builds the HTTP handler.
//
// Routing is done by hand rather than with http.ServeMux, and that is a security decision, not a
// stylistic one. ServeMux normalises the request path and answers a traversal attempt with a 307 to
// the cleaned path: `GET /../SECRET.txt` becomes a redirect to `/SECRET.txt`. Nothing escapes that
// way, because the redirected request is refused on its own merits -- but the refusal never appears
// in the log, the attempt is silently rewritten into a different request, and a reviewer reading the
// log cannot tell a probe from a typo. Dispatching on the raw decoded path keeps every rejection
// explicit and visible.
func Handler(cfg Config) http.Handler {
	var requests atomic.Uint64
	dispatch := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == ReservedPrefix+"health":
			serveHealth(w, r, cfg)
		case r.URL.Path == ReservedPrefix+"platform":
			servePlatformPage(w, r, cfg)
		case r.URL.Path == ReservedPrefix+"shutdown":
			serveShutdown(w, r, cfg)
		case strings.HasPrefix(r.URL.Path, ReservedPrefix):
			http.NotFound(w, r)
		default:
			serveStatic(w, r, cfg)
		}
	})
	return logging(cfg.Log, &requests, dispatch)
}

// logging records method, path, status, bytes and duration. Nothing else: no IP (it is always
// 127.0.0.1), no user agent, no query string, no cookies, no referer. The log is meant to be safe to
// forward with a diagnostic report without anyone having to read it first.
func logging(log Logger, counter *atomic.Uint64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &recorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if log == nil {
			return
		}
		n := counter.Add(1)
		log(fmt.Sprintf("%s req=%d %s %s -> %d %dB %.1fms",
			start.Format("2006-01-02T15:04:05.000Z07:00"), n, r.Method, r.URL.Path,
			rec.status, rec.bytes, float64(time.Since(start).Microseconds())/1000.0))
	})
}

type recorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *recorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

func serveHealth(w http.ResponseWriter, r *http.Request, cfg Config) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w)
		return
	}
	body, err := json.MarshalIndent(cfg.Health, "", "  ")
	if err != nil {
		http.Error(w, "health encoding failed", http.StatusInternalServerError)
		return
	}
	body = append(body, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

func serveShutdown(w http.ResponseWriter, r *http.Request, cfg Config) {
	if cfg.Shutdown == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "shutdown requires POST", http.StatusMethodNotAllowed)
		return
	}
	// The token lives in the user's own state directory and is regenerated on every start. It makes
	// the endpoint unusable by any page the browser happens to load, which is the only threat that
	// exists against a loopback-only listener.
	if cfg.ShutdownToken == "" || r.Header.Get("X-Civic-Token") != cfg.ShutdownToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, "stopping\n")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go cfg.Shutdown()
}

func methodNotAllowed(w http.ResponseWriter) {
	w.Header().Set("Allow", "GET, HEAD")
	http.Error(w, "only GET and HEAD are served", http.StatusMethodNotAllowed)
}

// resolve maps a request path to a file inside the document root, or reports why it will not.
//
// Every rejection below is a case that a real deployment has been attacked with or has broken on, and
// each is refused explicitly rather than normalised away, so that the refusal is visible in the log
// instead of silently becoming a different request.
func resolve(appDir, urlPath string) (string, int, string) {
	if strings.ContainsRune(urlPath, 0) {
		return "", http.StatusBadRequest, "NUL byte in path"
	}
	// net/http has already percent-decoded r.URL.Path, so %2e%2e%2f and %5c arrive here as their
	// decoded selves and are caught by the two checks below. That is the point of inspecting the
	// decoded form rather than RequestURI.
	if strings.ContainsRune(urlPath, '\\') {
		return "", http.StatusBadRequest, "backslash in path"
	}
	if !strings.HasPrefix(urlPath, "/") {
		return "", http.StatusBadRequest, "path is not absolute"
	}
	for _, seg := range strings.Split(urlPath, "/") {
		if seg == ".." {
			return "", http.StatusBadRequest, "parent-directory segment in path"
		}
		// A trailing dot or space is stripped by the Win32 layer, so "index.html." and "index.html "
		// would open the same file under a name the checks above never saw. Refuse both.
		if seg != "" && (strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ")) {
			return "", http.StatusBadRequest, "path segment ends in a dot or space"
		}
		if strings.ContainsAny(seg, `:*?"<>|`) {
			return "", http.StatusBadRequest, "reserved Windows character in path"
		}
	}

	clean := path.Clean(urlPath)
	if clean == "/" {
		clean = "/index.html"
	}
	if strings.HasSuffix(urlPath, "/") && clean != "/index.html" {
		// A directory URL. There is no listing and no implicit index below the root, so this is a
		// miss rather than a redirect -- exactly what BusyBox httpd did on the validated target.
		return "", http.StatusNotFound, "directory request"
	}

	rel := filepath.FromSlash(strings.TrimPrefix(clean, "/"))
	full := filepath.Join(appDir, rel)

	// The containment check is done on the resolved absolute forms and requires a separator after the
	// root, so a sibling directory whose name merely starts with the root's name cannot pass.
	rootAbs, err := filepath.Abs(appDir)
	if err != nil {
		return "", http.StatusInternalServerError, "cannot resolve document root"
	}
	fullAbs, err := filepath.Abs(full)
	if err != nil {
		return "", http.StatusBadRequest, "cannot resolve request path"
	}
	if !strings.EqualFold(fullAbs, rootAbs) &&
		!strings.HasPrefix(strings.ToLower(fullAbs), strings.ToLower(rootAbs)+string(filepath.Separator)) {
		return "", http.StatusBadRequest, "path escapes the document root"
	}
	return fullAbs, http.StatusOK, ""
}

func serveStatic(w http.ResponseWriter, r *http.Request, cfg Config) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w)
		return
	}

	full, code, why := resolve(cfg.AppDir, r.URL.Path)
	if code != http.StatusOK {
		http.Error(w, why, code)
		return
	}

	// Lstat, not Stat: a reparse point inside the payload would otherwise be followed to wherever it
	// points, and the containment check above only constrains the *name*, not the target.
	info, err := os.Lstat(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if info.IsDir() {
		http.Error(w, "directory listing is not served", http.StatusNotFound)
		return
	}
	if !info.Mode().IsRegular() {
		http.Error(w, "not a regular file", http.StatusNotFound)
		return
	}

	ct, known := ContentTypeFor(full)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !known {
		// Refusing would be worse: a payload the verifier let through should still be delivered. But
		// say so in the log, because it means the verifier and this table disagree.
		if cfg.Log != nil {
			cfg.Log(fmt.Sprintf("warning: no content type for %s; served as application/octet-stream",
				r.URL.Path))
		}
	}
	w.Header().Set("Cache-Control", cacheControlFor(r.URL.Path))

	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()

	// ServeContent, not io.Copy: it is the standard library's implementation of conditional requests,
	// range requests and the HEAD/GET distinction, and it will not sniff a type we have already set.
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// cacheControlFor keeps the three files whose identity is stable revalidating, and lets the
// content-hashed assets be cached hard.
//
// This is the one intentional divergence from the validated UOS deployment, where BusyBox httpd sent
// no cache headers at all. It cannot change correctness: everything under assets/ carries a content
// hash in its filename, so an immutable answer for those URLs is true by construction, and
// everything else is told to revalidate, which is stricter than sending nothing.
func cacheControlFor(urlPath string) string {
	if strings.HasPrefix(urlPath, "/assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}
