package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// transcriptName is the file every civic-admin run appends to.
const transcriptName = "install.log"

// startTranscript tees this run's stdout and stderr into <root>\logs\install.log.
//
// ## Why this is not optional
//
// The installer runs civic-admin with Flags: runhidden, so nothing it prints reaches a human. When
// activation failed during the first RC1 install rehearsal, Setup reported exit code 5 and the reason --
// which the program had printed perfectly clearly -- was simply gone. The only way to find it was to
// re-run the command by hand, and by then the state had changed and the failure did not reproduce.
//
// A colleague in the field has no way to re-run anything by hand. So the transcript is always on, and the
// diagnostics tool collects it: a failed activation now explains itself in a file the user can forward.
//
// The log holds what the program printed about the deployment -- release ids, paths inside the
// installation, digest verdicts. No records, no tokens, no browser data.
func startTranscript(logsDir string) func() {
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return func() {}
	}
	path := filepath.Join(logsDir, transcriptName)
	// Cap it the same way the server caps its own log, so a machine that fails an install repeatedly
	// cannot fill a user's profile.
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return func() {}
	}

	header := fmt.Sprintf("\n===== %s  civic-admin %v\n", time.Now().Format(time.RFC3339), os.Args[1:])
	_, _ = f.WriteString(header)

	realOut, realErr := os.Stdout, os.Stderr
	outR, outW, err1 := os.Pipe()
	errR, errW, err2 := os.Pipe()
	if err1 != nil || err2 != nil {
		_ = f.Close()
		return func() {}
	}
	os.Stdout, os.Stderr = outW, errW

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(io.MultiWriter(realOut, f), outR); done <- struct{}{} }()
	go func() { _, _ = io.Copy(io.MultiWriter(realErr, f), errR); done <- struct{}{} }()

	return func() {
		_ = outW.Close()
		_ = errW.Close()
		<-done
		<-done
		os.Stdout, os.Stderr = realOut, realErr
		_ = f.Close()
	}
}
