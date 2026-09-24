//go:build windows

// Package winproc proves whether a given process is a server this installation started, and stops it
// only if that proof holds.
//
// ## Why a PID is not an identity
//
// A PID is reused. If the recorded server exits and the operating system hands its number to the
// user's text editor, then "stop the server" becomes "terminate the editor", and the user loses
// unsaved work because of a stale file. The UOS deployment solved this by reading field 22 of
// /proc/<pid>/stat -- the process start time, which no later process can inherit. Windows exposes the
// same fact through GetProcessTimes, and this package uses it the same way: the creation time is the
// token that makes a PID mean one specific process for ever.
//
// ## The four facts
//
// An owned server must satisfy all of:
//
//  1. the PID is alive;
//  2. its creation time equals the recorded creation time;
//  3. its image path equals the recorded server executable inside this installation;
//  4. the recorded install root and release id match the ones being asked about.
//
// Any single mismatch means "this is not our process", and the answer is to refuse, not to guess.
// Refusing leaves a stale state file behind, which is recoverable by hand; guessing wrong terminates
// something that belongs to the user, which is not.
//
// Only the standard library is used. The three calls that syscall does not already expose are bound
// through syscall.NewLazyDLL, which is how the standard library itself reaches them.
package winproc

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	// PROCESS_QUERY_LIMITED_INFORMATION is the least privilege that still yields the image path and
	// the creation time. PROCESS_QUERY_INFORMATION would also work and is what most code reaches for,
	// but it grants more than is needed and fails more often against protected processes.
	processQueryLimitedInformation = 0x1000
	processTerminate               = 0x0001
	synchronize                    = 0x00100000
)

var (
	kernel32                      = syscall.NewLazyDLL("kernel32.dll")
	procQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
)

// ErrNotFound reports that no process with that PID is alive.
var ErrNotFound = errors.New("process not found")

// Identity is the durable, PID-reuse-proof description of a running server.
//
// It is what gets written to the state file and what a later launcher, status or stop compares
// against. Every field is a fact about the process or the installation; none of it is a secret and
// none of it is user data, so the whole struct is safe to put in a diagnostic report.
type Identity struct {
	PID          int    `json:"pid"`
	ExePath      string `json:"exePath"`
	CreationTime int64  `json:"creationTime"` // Windows FILETIME, 100ns ticks since 1601-01-01 UTC
	InstallRoot  string `json:"installRoot"`
	ReleaseID    string `json:"releaseId"`
	Origin       string `json:"origin"`
}

// Describes reports whether id could plausibly describe a server of this installation and release.
// This is the cheap check that does not touch the operating system.
func (id Identity) Describes(installRoot, releaseID string) bool {
	return samePath(id.InstallRoot, installRoot) && id.ReleaseID == releaseID
}

// Inspect reads the live facts about a PID.
func Inspect(pid int) (exePath string, creationTime int64, err error) {
	if pid <= 0 {
		return "", 0, fmt.Errorf("illegal pid %d", pid)
	}
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		// ERROR_INVALID_PARAMETER is what Windows returns for a PID that no longer exists, which is
		// the ordinary case after a server has exited.
		return "", 0, fmt.Errorf("%w: cannot open pid %d: %v", ErrNotFound, pid, err)
	}
	defer func() { _ = syscall.CloseHandle(h) }()

	// A process that has exited but whose handle is still held by someone -- a parent that has not
	// reaped it, for instance -- can still be opened. Its image path cannot be read, and
	// QueryFullProcessImageNameW reports that as ERROR_GEN_FAILURE, "a device attached to the system
	// is not functioning": an error message with no relationship to the cause, which cost real time to
	// diagnose. Ask for the exit code first so the answer is "it has exited" rather than a hardware
	// complaint.
	//
	// The one blind spot is a process whose genuine exit code is 259; Windows offers no way to tell
	// that apart from STILL_ACTIVE. It cannot arise for the server, which exits 0, 2, 3, 4 or 5.
	if err := exitedAlready(h); err != nil {
		return "", 0, fmt.Errorf("%w: pid %d has exited", ErrNotFound, pid)
	}

	exePath, err = imagePath(h)
	if err != nil {
		return "", 0, err
	}
	var creation, exit, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return "", 0, fmt.Errorf("cannot read process times for pid %d: %w", pid, err)
	}
	return exePath, filetimeTicks(creation), nil
}

func imagePath(h syscall.Handle) (string, error) {
	buf := make([]uint16, syscall.MAX_LONG_PATH)
	size := uint32(len(buf))
	r, _, e := procQueryFullProcessImageName.Call(uintptr(h), 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return "", fmt.Errorf("QueryFullProcessImageNameW failed: %w", e)
	}
	return syscall.UTF16ToString(buf[:size]), nil
}

func filetimeTicks(ft syscall.Filetime) int64 {
	return int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
}

// stillActive is the exit code Windows reports for a process that has not exited.
const stillActive = 259

// exitedAlready returns a non-nil error when the process behind h has already terminated.
func exitedAlready(h syscall.Handle) error {
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		// If the exit code cannot be read, do not claim the process has exited -- let the caller's
		// later checks decide. Guessing "gone" here would make a live server look dead.
		return nil
	}
	if code == stillActive {
		return nil
	}
	return fmt.Errorf("process has exited with code %d", code)
}

// Current returns the identity of the calling process, for a server to record about itself.
func Current(installRoot, releaseID, origin string) (Identity, error) {
	pid := syscall.Getpid()
	exe, creation, err := Inspect(pid)
	if err != nil {
		return Identity{}, err
	}
	return Identity{
		PID:          pid,
		ExePath:      exe,
		CreationTime: creation,
		InstallRoot:  installRoot,
		ReleaseID:    releaseID,
		Origin:       origin,
	}, nil
}

// Verify re-reads the live process and reports whether it is still the one described by id.
//
// The returned reason is always populated when ok is false, and is written for a log rather than for
// a user: "the pid is alive but was created later" is the sentence that explains a refusal to
// terminate, and it needs to be in the record.
func Verify(id Identity) (ok bool, reason string) {
	if id.PID <= 0 {
		return false, "recorded pid is not a pid"
	}
	exe, creation, err := Inspect(id.PID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, fmt.Sprintf("pid %d is no longer running", id.PID)
		}
		return false, fmt.Sprintf("cannot inspect pid %d: %v", id.PID, err)
	}
	if creation != id.CreationTime {
		return false, fmt.Sprintf(
			"pid %d is alive but its creation time is %d, not the recorded %d; the number has been reused",
			id.PID, creation, id.CreationTime)
	}
	if !samePath(exe, id.ExePath) {
		return false, fmt.Sprintf("pid %d runs %q, not the recorded %q", id.PID, exe, id.ExePath)
	}
	return true, ""
}

// VerifyOwned adds the installation-scope check: the process must also be the server of this
// installation and release, not of a second installation in another user profile.
func VerifyOwned(id Identity, installRoot, releaseID string) (bool, string) {
	if !id.Describes(installRoot, releaseID) {
		return false, fmt.Sprintf(
			"the recorded server belongs to install %q release %q, not to %q release %q",
			id.InstallRoot, id.ReleaseID, installRoot, releaseID)
	}
	// The executable must live inside the installation. Without this, a state file naming any
	// program on the machine would be enough to authorise terminating it.
	if !withinTree(id.ExePath, installRoot) {
		return false, fmt.Sprintf("the recorded executable %q is not inside %q", id.ExePath, installRoot)
	}
	return Verify(id)
}

// Terminate stops a process, but only after re-proving its identity in the same breath.
//
// The re-proof is not redundant with the caller's check. Between a caller deciding to stop a server
// and the kill landing, the server can exit and its PID can be reused -- the window is small and the
// consequence is terminating an unrelated program, so the proof has to be as close to the kill as it
// can be made. This mirrors civic_server_stop() in the UOS runtime, which re-proves ownership
// immediately before SIGKILL for the same reason.
func Terminate(id Identity, installRoot, releaseID string) error {
	ok, reason := VerifyOwned(id, installRoot, releaseID)
	if !ok {
		return fmt.Errorf("refusing to terminate pid %d: %s", id.PID, reason)
	}
	h, err := syscall.OpenProcess(processTerminate|synchronize|processQueryLimitedInformation,
		false, uint32(id.PID))
	if err != nil {
		return fmt.Errorf("cannot open pid %d for termination: %w", id.PID, err)
	}
	defer func() { _ = syscall.CloseHandle(h) }()

	// Re-read through THIS handle. The handle pins the kernel object, so from here on the PID cannot
	// be silently reused underneath us: if these facts still match, the process this handle refers to
	// is the recorded one.
	exe, creation, err := func() (string, int64, error) {
		p, err := imagePath(h)
		if err != nil {
			return "", 0, err
		}
		var c, e, k, u syscall.Filetime
		if err := syscall.GetProcessTimes(h, &c, &e, &k, &u); err != nil {
			return "", 0, err
		}
		return p, filetimeTicks(c), nil
	}()
	if err != nil {
		return fmt.Errorf("refusing to terminate pid %d: cannot re-verify through the handle: %w", id.PID, err)
	}
	if creation != id.CreationTime || !samePath(exe, id.ExePath) {
		return fmt.Errorf(
			"refusing to terminate pid %d: it changed identity between the check and the kill (exe=%q creation=%d)",
			id.PID, exe, creation)
	}

	if err := syscall.TerminateProcess(h, 1); err != nil {
		return fmt.Errorf("cannot terminate pid %d: %w", id.PID, err)
	}
	// A terminated process is not gone until the kernel says so. Waiting means a caller that starts a
	// replacement immediately afterwards does not race the old one for the port.
	if _, err := syscall.WaitForSingleObject(h, 5000); err != nil {
		return fmt.Errorf("terminated pid %d but the wait failed: %w", id.PID, err)
	}
	return nil
}

// Alive reports whether a PID is running at all, with no identity claim. Used only for reporting.
func Alive(pid int) bool {
	_, _, err := Inspect(pid)
	return err == nil
}

// samePath compares two Windows paths for equality the way the filesystem does: case-insensitively,
// with separators normalised. A comparison with == would call the same file by two names different.
func samePath(a, b string) bool {
	return strings.EqualFold(normalise(a), normalise(b))
}

func normalise(p string) string {
	if p == "" {
		return ""
	}
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	return filepath.Clean(p)
}

// withinTree reports whether child is root itself or lies under it. The separator in the prefix
// matters: without it, "C:\A\CivicWorkDeskOther" would count as being inside "C:\A\CivicWorkDesk".
func withinTree(child, root string) bool {
	c, r := normalise(child), normalise(root)
	if c == "" || r == "" {
		return false
	}
	if strings.EqualFold(c, r) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(c), strings.ToLower(r)+string(filepath.Separator))
}
