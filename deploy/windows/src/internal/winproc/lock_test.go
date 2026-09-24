//go:build windows

package winproc

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestLockIsExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "launch.lock")

	first, err := AcquireLock(path)
	if err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}

	// Exclusion here is enforced by the kernel against the file handle, so it holds within one process
	// as well as across processes -- which is exactly why this primitive replaced the named mutex,
	// whose exclusion was per-thread and therefore invisible to a same-process check.
	second, err := AcquireLock(path)
	if err == nil {
		second.Release()
		t.Fatal("a second acquire succeeded while the lock was held")
	}
	if !errors.Is(err, ErrLockBusy) {
		t.Fatalf("second acquire failed with %v, want ErrLockBusy", err)
	}

	// The refusal must name the holder, or "busy" is not actionable.
	if !strings.Contains(err.Error(), "pid="+strconv.Itoa(syscall.Getpid())) {
		t.Errorf("the busy message does not name the holding pid: %v", err)
	}

	first.Release()
	third, err := AcquireLock(path)
	if err != nil {
		t.Fatalf("acquire after release failed: %v", err)
	}
	third.Release()
	third.Release() // must be safe twice
}

func TestLockCreatesItsDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a", "b", "c", "launch.lock")
	lock, err := AcquireLock(path)
	if err != nil {
		t.Fatalf("acquire failed: %v", err)
	}
	defer lock.Release()
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the lock file was not created: %v", err)
	}
	if lock.Path() != path {
		t.Errorf("Path() = %q, want %q", lock.Path(), path)
	}
}

// A lock file left over from a process that is gone must not block anything: the kernel released the
// handle when that process exited, so acquiring again has to succeed even though the file still exists
// and still names the dead holder. This is the stale-lock failure mode that a lock-file design has and
// this design does not.
func TestStaleLockFileDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "launch.lock")

	lock, err := AcquireLock(path)
	if err != nil {
		t.Fatalf("acquire failed: %v", err)
	}
	lock.Release() // stands in for the holder's process exiting

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the lock file should still exist on disk: %v", err)
	}
	again, err := AcquireLock(path)
	if err != nil {
		t.Fatalf("a leftover lock file blocked a new acquisition: %v", err)
	}
	again.Release()
}

func TestNilLockReleaseIsSafe(t *testing.T) {
	var l *Lock
	l.Release()
	if l.Path() != "" {
		t.Error("a nil lock reported a path")
	}
}
