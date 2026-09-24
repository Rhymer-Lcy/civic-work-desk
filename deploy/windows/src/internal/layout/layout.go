// Package layout resolves the per-user installation tree and reads and writes the release pointer.
//
// The tree is deliberately the Windows equivalent of the UOS layout, so the two deployments can be
// reasoned about together:
//
//	%LOCALAPPDATA%\CivicWorkDesk\
//	    releases\<release-id>\app\      the PWA payload, byte-identical to the UOS one
//	    releases\<release-id>\server\   the release's own server binary set
//	    releases\<release-id>\VERSION
//	    releases\<release-id>\SHA256SUMS.txt
//	    bin\                            the launcher/admin/diag binaries the shortcuts point at
//	    state\                          owned-server state; never contains user records
//	    logs\
//	    current.txt                     the active release id
//	    previous.txt                    the release to roll back to
//
// Two pointer files replace the UOS symlink. Windows can make junctions without elevation, but a
// text file that is written by rename and then read back is simpler to verify and has no
// destination-descent hazard at all -- the defect that cost Phase 3 a whole corrective pass, where
// `mv -f` onto a symlink-to-directory moved the new pointer *inside* the old release while the
// installer printed success.
package layout

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ReleaseIDPattern is deliberately strict. A release id becomes a directory name, so anything that
// could traverse, alias or collide is rejected at the point of entry rather than sanitised later.
//
// The trailing character must be alphanumeric, which is not cosmetic: Win32 strips a trailing dot or
// space from a path component, so "2026.09.24-a." and "2026.09.24-a" would name the SAME directory
// under two different ids. That is the same aliasing hazard the HTTP path resolver refuses, and it was
// caught here by a test asserting the trailing-dot form is illegal while the pattern still allowed it.
var ReleaseIDPattern = regexp.MustCompile(
	`^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9]([a-z0-9.-]{0,29}[a-z0-9])?$`)

// ErrNoActiveRelease reports that current.txt is absent or empty: nothing is installed, or an
// installation failed before activation. Both leave the tree usable, which is the point.
var ErrNoActiveRelease = errors.New("no active release")

// Tree is an installation root and the paths derived from it.
type Tree struct {
	Root string
}

// Default returns the tree under %LOCALAPPDATA%, the location an ordinary user can always write.
func Default() (Tree, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return Tree{}, errors.New("LOCALAPPDATA is not set; cannot locate the per-user installation root")
	}
	return Tree{Root: filepath.Join(base, "CivicWorkDesk")}, nil
}

// At returns a tree rooted at an explicit path. Used by the installer, which knows where it put
// things, and by the tests, which must not touch the real installation.
func At(root string) Tree { return Tree{Root: root} }

func (t Tree) Releases() string    { return filepath.Join(t.Root, "releases") }
func (t Tree) Bin() string         { return filepath.Join(t.Root, "bin") }
func (t Tree) State() string       { return filepath.Join(t.Root, "state") }
func (t Tree) Logs() string        { return filepath.Join(t.Root, "logs") }
func (t Tree) CurrentFile() string { return filepath.Join(t.Root, "current.txt") }
func (t Tree) PrevFile() string    { return filepath.Join(t.Root, "previous.txt") }

// Release returns the directory of one release. The id is validated so a caller cannot reach outside
// releases\ by passing "..", an absolute path or a drive-relative name.
func (t Tree) Release(id string) (string, error) {
	if !ReleaseIDPattern.MatchString(id) {
		return "", fmt.Errorf("illegal release id %q", id)
	}
	return filepath.Join(t.Releases(), id), nil
}

// AppDir is the document root the server serves. Nothing outside it is reachable over HTTP.
func (t Tree) AppDir(id string) (string, error) {
	dir, err := t.Release(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "app"), nil
}

// EnsureDirs creates the fixed directories. Safe to repeat: this runs on every install, resume and
// repair.
func (t Tree) EnsureDirs() error {
	for _, dir := range []string{t.Root, t.Releases(), t.Bin(), t.State(), t.Logs()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("cannot create %s: %w", dir, err)
		}
	}
	return nil
}

// ReadPointer returns the release id in a pointer file. A missing or empty file is
// ErrNoActiveRelease rather than a hard error, because "nothing is active yet" is a normal state
// during a first install and after a failed activation.
func ReadPointer(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrNoActiveRelease
	}
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", path, err)
	}
	id := strings.TrimSpace(string(raw))
	if id == "" {
		return "", ErrNoActiveRelease
	}
	if !ReleaseIDPattern.MatchString(id) {
		return "", fmt.Errorf("%s holds an illegal release id %q", path, id)
	}
	return id, nil
}

// WritePointer replaces a pointer file atomically and then reads it back.
//
// The read-back is not ceremony. Phase 3 shipped a pointer update that reported success while having
// written the pointer into the wrong place; the only thing that would have caught it at the time was
// asking the filesystem what the pointer now says. os.Rename onto an existing *file* on Windows
// replaces it, and cannot descend into it the way the POSIX bug did -- but the check costs one
// syscall and is what makes the claim "the pointer now says X" a measurement instead of an
// assumption.
func WritePointer(path, id string) error {
	if !ReleaseIDPattern.MatchString(id) {
		return fmt.Errorf("refusing to write illegal release id %q", id)
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, []byte(id+"\r\n"), 0o644); err != nil {
		return fmt.Errorf("cannot write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("cannot move %s into place at %s: %w", tmp, path, err)
	}
	got, err := ReadPointer(path)
	if err != nil {
		return fmt.Errorf("wrote %s but cannot read it back: %w", path, err)
	}
	if got != id {
		return fmt.Errorf("wrote %q to %s but it reads back as %q", id, path, got)
	}
	return nil
}

// ActiveRelease returns the id in current.txt.
func (t Tree) ActiveRelease() (string, error) { return ReadPointer(t.CurrentFile()) }

// PreviousRelease returns the id in previous.txt.
func (t Tree) PreviousRelease() (string, error) { return ReadPointer(t.PrevFile()) }

// RequiredReleaseEntries are the four things every release directory must contain, and the only
// four. An unexpected entry means the directory is a half-extracted or foreign tree, and activating
// it would be activating something we cannot describe.
var RequiredReleaseEntries = []string{"app", "server", "SHA256SUMS.txt", "VERSION"}

// AssertReleaseShape checks a release directory is exactly what a release is.
//
// This is the Windows counterpart of the UOS assert_release_shape(), which exists because two
// concurrent installers once both reported success while one had nested its payload inside the
// other's.
func (t Tree) AssertReleaseShape(id string) error {
	dir, err := t.Release(id)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("cannot read release directory %s: %w", dir, err)
	}
	found := map[string]bool{}
	var unexpected []string
	for _, e := range entries {
		name := e.Name()
		if slicesContains(RequiredReleaseEntries, name) {
			found[name] = true
			continue
		}
		unexpected = append(unexpected, name)
	}
	var missing []string
	for _, want := range RequiredReleaseEntries {
		if !found[want] {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 || len(unexpected) > 0 {
		return fmt.Errorf("release %s has the wrong shape (missing: %v, unexpected: %v)",
			id, missing, unexpected)
	}
	for _, want := range []string{"app", "server"} {
		info, err := os.Stat(filepath.Join(dir, want))
		if err != nil || !info.IsDir() {
			return fmt.Errorf("release %s: %s is not a directory", id, want)
		}
	}
	return nil
}

// InstalledReleases lists the release ids present on disk, newest name last. Used by status,
// rollback and the pruning decision.
func (t Tree) InstalledReleases() ([]string, error) {
	entries, err := os.ReadDir(t.Releases())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot list %s: %w", t.Releases(), err)
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() && ReleaseIDPattern.MatchString(e.Name()) {
			ids = append(ids, e.Name())
		}
	}
	return ids, nil
}

func slicesContains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
