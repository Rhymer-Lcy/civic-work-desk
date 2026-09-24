package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// logName is one file per installation rather than one per run. A per-run file would leave a directory
// nobody prunes; one file with a size cap is easier to attach to a diagnostic report and easier to
// reason about.
const logName = "server.log"

// maxLogBytes caps the log at a size that still holds a long session but can never fill a user's
// profile. When it is reached the file is rotated once, so there is at most one generation of history.
const maxLogBytes = 2 << 20 // 2 MiB

func logPath(logsDir string) string { return filepath.Join(logsDir, logName) }

// openLog returns a logger that appends to the installation's log file, and a function that closes it.
//
// Failing to open the log is not fatal to serving -- a user whose profile has an unwritable logs
// directory should still be able to use the program -- but it must be visible, so the fallback says so
// on stderr rather than silently discarding every line.
func openLog(logsDir string, alsoStderr bool) (func(string), func(), error) {
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, nil, fmt.Errorf("cannot create %s: %w", logsDir, err)
	}
	path := logPath(logsDir)
	rotateIfLarge(path)

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: cannot write %s (%v); logging to stderr only\n", path, err)
		var mu sync.Mutex
		return func(line string) {
			mu.Lock()
			defer mu.Unlock()
			fmt.Fprintln(os.Stderr, line)
		}, func() {}, nil
	}

	var mu sync.Mutex
	logger := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		_, _ = fmt.Fprintln(f, line)
		if alsoStderr {
			fmt.Fprintln(os.Stderr, line)
		}
	}
	return logger, func() { _ = f.Close() }, nil
}

func rotateIfLarge(path string) {
	info, err := os.Stat(path)
	if err != nil || info.Size() < maxLogBytes {
		return
	}
	// Ignore the error: if the rotation cannot happen the log simply keeps growing past the cap, which
	// is strictly better than refusing to start.
	_ = os.Remove(path + ".1")
	_ = os.Rename(path, path+".1")
}
