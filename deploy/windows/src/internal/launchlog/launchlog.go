// Package launchlog records what each click on the application shortcut led to.
//
// ## Why this exists
//
// civic-launch is a GUI-subsystem program, so it has no console. RC1-RC3 printed every failure to
// stderr, and when the program is started from a shortcut stderr is an invalid handle: the write fails,
// nothing appears, and the only evidence of a port conflict, a blocked executable or a browser that
// would not open was that nothing happened. (Measured: a GUI-subsystem binary started through the shell
// gets "The handle is invalid" on every stdout write.) The launcher now shows a dialog, and this log is
// the durable half -- the diagnostics tool reads it, so a tester who dismissed the dialog still hands
// back what it said.
//
// ## What a line holds
//
// A timestamp with its offset, the command, a fixed outcome word, the exit code, and a technical detail
// that has been through the path redactor. No work content exists anywhere in the launcher to leak, and
// no URL other than the fixed origin is ever opened.
package launchlog

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// FileName is the log inside the installation's logs\ directory.
const FileName = "launch.log"

// maxBytes bounds the file. One generation of history is kept, as for server.log.
const maxBytes = 256 << 10

// Outcome is one fixed word per way a launch can end, so a report can be read and counted by eye.
type Outcome string

const (
	OK                  Outcome = "ok"
	NoRelease           Outcome = "no-release"
	StartingElsewhere   Outcome = "busy-starting"
	PortOtherInstall    Outcome = "port-conflict-other-installation"
	PortForeign         Outcome = "port-conflict-foreign-program"
	ServerBlockedPolicy Outcome = "server-blocked-by-policy"
	ServerBlockedCI     Outcome = "server-blocked-by-application-control"
	ServerBlockedAV     Outcome = "server-blocked-by-security-software"
	ServerMissing       Outcome = "server-executable-missing"
	ServerStartFailed   Outcome = "server-start-failed"
	HealthTimeout       Outcome = "server-not-responding"
	BrowserFailed       Outcome = "browser-launch-failed"
	Stopped             Outcome = "stopped"
	StopRefused         Outcome = "stop-refused"
	Internal            Outcome = "internal-error"
)

// Entry is one line.
type Entry struct {
	Time     time.Time
	Command  string
	Outcome  Outcome
	ExitCode int
	Release  string
	Detail   string
}

// Format renders an entry as one line. Newlines in the detail are flattened so a line is a record.
func Format(e Entry) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s outcome=%s exit=%d", e.Time.Format(time.RFC3339), e.Command, e.Outcome, e.ExitCode)
	if e.Release != "" {
		fmt.Fprintf(&b, " release=%s", e.Release)
	}
	if e.Detail != "" {
		detail := strings.Join(strings.Fields(e.Detail), " ")
		fmt.Fprintf(&b, " detail=%q", detail)
	}
	return b.String()
}

// Append adds an entry to logsDir\launch.log. Failure to write is returned but is never a reason for the
// launcher to behave differently: the dialog is what the user sees, and it does not depend on this file.
func Append(logsDir string, e Entry) error {
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(logsDir, FileName)
	if info, err := os.Stat(path); err == nil && info.Size() >= maxBytes {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	_, err = fmt.Fprintln(f, Format(e))
	return err
}

// Windows error codes that tell apart the ways an executable can be kept from starting.
const (
	errFileNotFound          syscall.Errno = 2
	errPathNotFound          syscall.Errno = 3
	errAccessDenied          syscall.Errno = 5
	errBadExeFormat          syscall.Errno = 193
	errExeMachineMismatch    syscall.Errno = 216
	errVirusInfected         syscall.Errno = 225
	errVirusDeleted          syscall.Errno = 226
	errDisabledByPolicy      syscall.Errno = 1260 // AppLocker, Software Restriction Policies
	errIntegrityPolicyBlock  syscall.Errno = 4551 // Windows Defender Application Control, Smart App Control
	errIntegrityPolicyBlock2 syscall.Errno = 4556 // the same family, audit-to-enforce variant
)

// ClassifyStartError maps the error from starting civic-server.exe to an outcome.
//
// The distinction matters to the person who has to act on it: a policy block is for an administrator,
// an anti-malware block must never be "solved" by the user turning protection off, and a missing file is
// usually a quarantine that a repair install puts right.
func ClassifyStartError(err error) (Outcome, syscall.Errno) {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ServerStartFailed, 0
	}
	switch errno {
	case errDisabledByPolicy:
		return ServerBlockedPolicy, errno
	case errIntegrityPolicyBlock, errIntegrityPolicyBlock2:
		return ServerBlockedCI, errno
	case errVirusInfected, errVirusDeleted:
		return ServerBlockedAV, errno
	case errFileNotFound, errPathNotFound:
		return ServerMissing, errno
	case errBadExeFormat, errExeMachineMismatch, errAccessDenied:
		return ServerStartFailed, errno
	}
	return ServerStartFailed, errno
}
