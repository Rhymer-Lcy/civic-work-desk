// Package release verifies a release directory against its own manifest and reads its metadata.
//
// The manifest is the same SHA256SUMS.txt format the UOS release carries, and it is checked at three
// moments: when the installer has extracted a payload and before it activates it, when a repair runs,
// and on demand from diagnostics. Verifying before activation is what makes "failure before activation
// leaves the current version usable" true rather than hoped for -- a truncated download or a
// half-extracted archive is caught while the old current.txt still points somewhere that works.
package release

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ManifestName is the file inside a release directory that lists every payload file and its digest.
const ManifestName = "SHA256SUMS.txt"

// VersionName is the release's key=value metadata file.
const VersionName = "VERSION"

// Entry is one manifest line: a lower-case hex digest and a slash-separated path relative to the
// release directory.
type Entry struct {
	Digest string
	Path   string
}

// ReadManifest parses SHA256SUMS.txt.
//
// The format is the one sha256sum(1) writes: "<64 hex> <two spaces or space-star> <path>". Paths are
// stored with forward slashes so the same manifest describes the payload identically on both
// platforms.
func ReadManifest(releaseDir string) ([]Entry, error) {
	path := filepath.Join(releaseDir, ManifestName)
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("cannot open %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()

	var entries []Entry
	seen := map[string]bool{}
	scanner := bufio.NewScanner(f)
	line := 0
	for scanner.Scan() {
		line++
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		digest, rest, ok := strings.Cut(text, " ")
		if !ok {
			return nil, fmt.Errorf("%s:%d: no space after the digest", path, line)
		}
		if len(digest) != 64 {
			return nil, fmt.Errorf("%s:%d: %q is not a sha256 digest", path, line, digest)
		}
		if _, err := hex.DecodeString(digest); err != nil {
			return nil, fmt.Errorf("%s:%d: %q is not hexadecimal", path, line, digest)
		}
		rel := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(rest), "*"))
		if rel == "" {
			return nil, fmt.Errorf("%s:%d: no path after the digest", path, line)
		}
		// A manifest entry that could point outside the release directory would turn verification into
		// an arbitrary-file read. Refuse the shape rather than sanitising it.
		if strings.Contains(rel, `\`) {
			return nil, fmt.Errorf("%s:%d: path %q uses a backslash; manifests are slash-separated", path, line, rel)
		}
		if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") {
			return nil, fmt.Errorf("%s:%d: path %q is absolute", path, line, rel)
		}
		for _, seg := range strings.Split(rel, "/") {
			if seg == ".." {
				return nil, fmt.Errorf("%s:%d: path %q leaves the release directory", path, line, rel)
			}
		}
		if seen[rel] {
			return nil, fmt.Errorf("%s:%d: %q is listed twice", path, line, rel)
		}
		seen[rel] = true
		entries = append(entries, Entry{Digest: strings.ToLower(digest), Path: rel})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("%s lists no files", path)
	}
	return entries, nil
}

// Result is the outcome of verifying a release directory.
type Result struct {
	Checked  int
	Missing  []string
	Mismatch []string
	Unlisted []string
	Manifest string
}

// OK reports whether nothing at all was wrong.
func (r Result) OK() bool {
	return len(r.Missing) == 0 && len(r.Mismatch) == 0 && len(r.Unlisted) == 0
}

// Summary renders the result for a log or a diagnostic report.
func (r Result) Summary() string {
	if r.OK() {
		return fmt.Sprintf("%d file(s) verified against %s; no missing, altered or unlisted file",
			r.Checked, r.Manifest)
	}
	return fmt.Sprintf("%d file(s) checked; missing=%v altered=%v unlisted=%v",
		r.Checked, r.Missing, r.Mismatch, r.Unlisted)
}

// Verify hashes every file the manifest lists and every file on disk.
//
// Both directions are checked on purpose. "Every file in the manifest is present and correct" is not
// "the payload is what the manifest describes": an extra file that nobody listed is exactly how a
// stray script or a leftover from a previous release ends up inside a document root, and a one-way
// check cannot see it. The same asymmetry was the subject of a Phase-3 lesson about audits that can
// only fail in one direction.
func Verify(releaseDir string) (Result, error) {
	res := Result{Manifest: ManifestName}
	entries, err := ReadManifest(releaseDir)
	if err != nil {
		return res, err
	}

	listed := map[string]bool{}
	for _, e := range entries {
		listed[strings.ToLower(e.Path)] = true
		full := filepath.Join(releaseDir, filepath.FromSlash(e.Path))
		got, err := FileDigest(full)
		if errors.Is(err, os.ErrNotExist) {
			res.Missing = append(res.Missing, e.Path)
			continue
		}
		if err != nil {
			return res, fmt.Errorf("cannot hash %s: %w", full, err)
		}
		res.Checked++
		if got != e.Digest {
			res.Mismatch = append(res.Mismatch, e.Path)
		}
	}

	// The manifest describes the payload, not the manifest itself or the metadata beside it.
	exempt := map[string]bool{
		strings.ToLower(ManifestName): true,
		strings.ToLower(VersionName):  true,
	}
	err = filepath.WalkDir(releaseDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(releaseDir, p)
		if err != nil {
			return err
		}
		slash := strings.ToLower(filepath.ToSlash(rel))
		if exempt[slash] || listed[slash] {
			return nil
		}
		res.Unlisted = append(res.Unlisted, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return res, fmt.Errorf("cannot walk %s: %w", releaseDir, err)
	}
	sort.Strings(res.Missing)
	sort.Strings(res.Mismatch)
	sort.Strings(res.Unlisted)
	return res, nil
}

// FileDigest returns the lower-case hex sha256 of a file.
func FileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Version is the parsed VERSION file: a flat key=value map, order preserved for reporting.
type Version struct {
	Keys   []string
	Values map[string]string
}

// Get returns a value, or "" when absent.
func (v Version) Get(key string) string { return v.Values[key] }

// ReadVersion parses the release's VERSION file.
func ReadVersion(releaseDir string) (Version, error) {
	path := filepath.Join(releaseDir, VersionName)
	raw, err := os.ReadFile(path)
	if err != nil {
		return Version{}, fmt.Errorf("cannot read %s: %w", path, err)
	}
	v := Version{Values: map[string]string{}}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue // the first line is a human-readable title, not a pair
		}
		key = strings.TrimSpace(key)
		if _, exists := v.Values[key]; !exists {
			v.Keys = append(v.Keys, key)
		}
		v.Values[key] = strings.TrimSpace(value)
	}
	return v, nil
}
