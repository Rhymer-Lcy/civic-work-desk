package httpserve

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The runtime endpoint (Phase 6): GET /api/civic/runtime answers which interface generation the active
// release expects, in the contract the shared application reads (src/app/pwa/runtime-generation.ts):
//
//	{ "schema": "civic-runtime/1", "appGeneration": "ui-<hash>", "releaseId": ..., "canonicalOrigin": ... }
//
// The generation comes from the release's own build output, app-generation.json, and is only served
// after it has been checked against the release: well formed, naming an entry script that exists, and
// naming the entry script index.html actually loads. Anything else is answered 503 with the reason, so
// the application stays silent and the update bootstrap refuses to guess; neither may treat a broken
// release as "current".

const (
	runtimeSchema      = "civic-runtime/1"
	generationSchema   = "civic-app-generation/1"
	generationFileName = "app-generation.json"
	generationMaxBytes = 64 << 10
)

var (
	generationPattern = regexp.MustCompile(`^ui-([A-Za-z0-9_-]{6,64})$`)
	entryPattern      = regexp.MustCompile(`^assets/index-([A-Za-z0-9_-]{6,64})\.js$`)
)

// AppGeneration is a release's validated app-generation.json.
type AppGeneration struct {
	Schema        string `json:"schema"`
	AppGeneration string `json:"appGeneration"`
	Entry         string `json:"entry"`
}

// LoadAppGeneration reads and validates app-generation.json in a release's app directory. It is the
// single definition of "this release knows its interface generation", used by the runtime endpoint and
// by civic-admin verify.
func LoadAppGeneration(appDir string) (AppGeneration, error) {
	var gen AppGeneration
	path := filepath.Join(appDir, generationFileName)
	info, err := os.Lstat(path)
	if err != nil {
		return gen, fmt.Errorf("%s is missing: %w", generationFileName, err)
	}
	if !info.Mode().IsRegular() || info.Size() > generationMaxBytes {
		return gen, fmt.Errorf("%s is not a small regular file", generationFileName)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return gen, fmt.Errorf("%s cannot be read: %w", generationFileName, err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&gen); err != nil {
		return gen, fmt.Errorf("%s is not the expected JSON: %w", generationFileName, err)
	}
	if gen.Schema != generationSchema {
		return gen, fmt.Errorf("%s has schema %q, want %q", generationFileName, gen.Schema, generationSchema)
	}
	hash := generationPattern.FindStringSubmatch(gen.AppGeneration)
	entry := entryPattern.FindStringSubmatch(gen.Entry)
	if hash == nil || entry == nil || hash[1] != entry[1] {
		return gen, fmt.Errorf("%s names generation %q and entry %q, which do not match",
			generationFileName, gen.AppGeneration, gen.Entry)
	}
	entryInfo, err := os.Lstat(filepath.Join(appDir, filepath.FromSlash(gen.Entry)))
	if err != nil || !entryInfo.Mode().IsRegular() {
		return gen, fmt.Errorf("the entry script %s is not in the release", gen.Entry)
	}
	index, err := os.ReadFile(filepath.Join(appDir, "index.html"))
	if err != nil {
		return gen, errors.New("index.html cannot be read")
	}
	if !strings.Contains(string(index), `src="./`+gen.Entry+`"`) {
		return gen, fmt.Errorf("index.html does not load %s", gen.Entry)
	}
	return gen, nil
}

type runtimeAnswer struct {
	Schema          string `json:"schema"`
	AppGeneration   string `json:"appGeneration,omitempty"`
	ReleaseID       string `json:"releaseId,omitempty"`
	CanonicalOrigin string `json:"canonicalOrigin,omitempty"`
	Error           string `json:"error,omitempty"`
}

func serveRuntime(w http.ResponseWriter, r *http.Request, cfg Config) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w)
		return
	}
	answer := runtimeAnswer{Schema: runtimeSchema}
	status := http.StatusOK
	if gen, err := LoadAppGeneration(cfg.AppDir); err != nil {
		answer.Error = err.Error()
		status = http.StatusServiceUnavailable
		if cfg.Log != nil {
			cfg.Log("runtime: " + err.Error())
		}
	} else {
		answer.AppGeneration = gen.AppGeneration
		answer.ReleaseID = cfg.Health.ReleaseID
		answer.CanonicalOrigin = cfg.Health.CanonicalOrigin
	}
	body, err := json.Marshal(answer)
	if err != nil {
		http.Error(w, "runtime encoding failed", http.StatusInternalServerError)
		return
	}
	body = append(body, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(status)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}
