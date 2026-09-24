//go:build windows

package winproc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// ErrLockBusy reports that another CivicWorkDesk operation of this installation holds the lock.
var ErrLockBusy = errors.New("another CivicWorkDesk operation is in progress")

// errSharingViolation is ERROR_SHARING_VIOLATION. Go's syscall package does not name it, so it is
// declared here rather than compared as a bare 32 at the call site.
const errSharingViolation = syscall.Errno(32)

// Lock is a single-holder lock for launch, install and stop operations.
//
// ## Why a file handle and not a named mutex
//
// A named Windows mutex looks like the obvious primitive and is the wrong one for a Go program:
// mutex ownership belongs to the acquiring *thread*, and the Go runtime moves goroutines between OS
// threads freely. So the release can be attempted from a thread that does not own the lock, and a
// second acquisition from another goroutine can land on the owning thread and succeed re-entrantly --
// which is exactly what happened when this was first written as a mutex: the exclusion test showed a
// second acquire succeeding while the lock was held.
//
// A file handle opened without write sharing has no thread affinity at all. Exclusion is enforced by
// the kernel against the handle, and the handle is closed by the kernel when the process exits for any
// reason, including a hard kill -- so there is no stale-lock state to reason about, which was the
// whole reason for preferring a kernel object over a lock file in the first place.
//
// The share mode is FILE_SHARE_READ rather than zero so that a process which loses the race can still
// open the file read-only and report *who* holds it. That is the property the UOS symlink-as-lock had
// -- `ln -s <pid> <lock>` carried the holder in one atomic operation -- and it is what turns "busy"
// into an actionable message.
type Lock struct {
	handle syscall.Handle
	path   string
}

// AcquireLock takes the lock at path, creating the file if needed. It never waits: a blocked
// operation should say so immediately rather than hang a Start Menu shortcut.
func AcquireLock(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("cannot create the directory for %s: %w", path, err)
	}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("illegal lock path %q: %w", path, err)
	}
	h, err := syscall.CreateFile(name,
		syscall.GENERIC_WRITE,
		syscall.FILE_SHARE_READ, // readers may report the holder; a second writer is refused
		nil,
		syscall.CREATE_ALWAYS,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0)
	if err != nil {
		if errors.Is(err, errSharingViolation) {
			return nil, fmt.Errorf("%w (held according to %s: %s)", ErrLockBusy, path, describeHolder(path))
		}
		return nil, fmt.Errorf("cannot open the lock %s: %w", path, err)
	}
	lock := &Lock{handle: h, path: path}
	// Record the holder so a contender's message can name it. Best effort: failing to write the note
	// must not fail the acquisition, because the lock itself is already held.
	if exe, err := os.Executable(); err == nil {
		note := fmt.Sprintf("pid=%d\r\nexe=%s\r\n", syscall.Getpid(), exe)
		var written uint32
		_ = syscall.WriteFile(h, []byte(note), &written, nil)
	}
	return lock, nil
}

// Release drops the lock. Safe to call more than once.
func (l *Lock) Release() {
	if l == nil || l.handle == 0 {
		return
	}
	_ = syscall.CloseHandle(l.handle)
	l.handle = 0
}

// Path returns the lock's path, for logs and diagnostics.
func (l *Lock) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

// describeHolder reads the note the holder left. It is only ever used to build an error message, so
// every failure resolves to a phrase rather than to an error.
func describeHolder(path string) string {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "unknown"
	}
	h, err := syscall.CreateFile(name,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, // must permit the holder's own write access
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0)
	if err != nil {
		return "unknown (the lock file cannot be read either)"
	}
	defer func() { _ = syscall.CloseHandle(h) }()

	buf := make([]byte, 512)
	var read uint32
	if err := syscall.ReadFile(h, buf, &read, nil); err != nil || read == 0 {
		return "unknown (the lock file carries no holder note)"
	}
	note := strings.ReplaceAll(strings.TrimSpace(string(buf[:read])), "\r\n", "; ")
	// If the note names a PID that is gone, say so: it means the holder died between our failed open
	// and this read, and a retry will now succeed.
	for _, field := range strings.Split(note, "; ") {
		if rest, ok := strings.CutPrefix(field, "pid="); ok {
			if pid, err := strconv.Atoi(rest); err == nil && !Alive(pid) {
				return note + " (that process is no longer running; retry)"
			}
		}
	}
	return note
}
