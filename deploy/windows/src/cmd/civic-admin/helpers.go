package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/redact"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

// binaries are copied from the release into bin\ so the Start Menu shortcut has one stable target that
// does not change when a release is added or removed. The shortcut therefore survives an upgrade
// untouched, which is what keeps a pinned taskbar icon working.
var binaries = []string{"civic-server.exe", "civic-launch.exe", "civic-diag.exe", "civic-admin.exe"}

func releaseServerExe(tree layout.Tree, releaseID string) string {
	dir, err := tree.Release(releaseID)
	if err != nil {
		return ""
	}
	exe := filepath.Join(dir, "server", serverExeName)
	if _, err := os.Stat(exe); err != nil {
		return ""
	}
	return exe
}

// installBinaries refreshes bin\ from the release.
//
// Copy, not a junction or a symlink: bin\ has to keep working when a release directory is pruned, and a
// dangling link would turn a shortcut into an error dialog.
func installBinaries(tree layout.Tree, releaseID string) error {
	dir, err := tree.Release(releaseID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(tree.Bin(), 0o755); err != nil {
		return fmt.Errorf("cannot create %s: %w", tree.Bin(), err)
	}
	sweepSupersededBinaries(tree.Bin())
	for _, name := range binaries {
		src := filepath.Join(dir, "server", name)
		data, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("cannot read %s: %w", src, err)
		}
		if err := replaceBinary(filepath.Join(tree.Bin(), name), data); err != nil {
			return err
		}
	}
	return nil
}

// supersededSuffix marks a binary that has been moved aside because its file was in use.
const supersededSuffix = ".superseded"

// replaceBinary puts data at dst even when dst is a running executable.
//
// ## Why the rename-aside step exists
//
// Windows holds an open section against a running image: the file cannot be written to and cannot be
// deleted. It CAN be renamed. Without exploiting that, this function cannot replace civic-admin.exe --
// and civic-admin.exe is the program running it, so every activation would fail with "Access is denied"
// on the last of the four binaries. That is exactly how the first RC1 installer failed: extraction and
// verification both succeeded, activation exited 5, and current.txt was never written.
//
// Moving the old image aside rather than skipping it matters for the upgrade case, where bin\ must end up
// holding the NEW release's tools. The aside copy is deleted on the next run, once nothing is executing
// it any more.
// ## And why it tries not to replace anything at all
//
// A file that Setup extracted seconds ago can be held briefly by an anti-malware scan, and a rename
// against it fails with "Access is denied" exactly like a running image does. That is what made the
// first RC1 install rehearsal fail intermittently: activation returned 5 under Setup while the same
// command succeeded by hand a minute later, once the scan had finished. The original lock holder was
// never positively identified -- only that the failure was transient -- so the fix removes the whole
// class instead of guessing: if the destination already holds exactly these bytes there is nothing to
// replace, and a first install is precisely that case, because Setup has already put the identical
// binaries in bin\. Anything that does need replacing is retried over a few seconds.
func replaceBinary(dst string, data []byte) error {
	if existing, err := os.ReadFile(dst); err == nil && bytes.Equal(existing, data) {
		return nil
	}

	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return fmt.Errorf("cannot write %s: %w", tmp, err)
	}

	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		if attempt > 0 {
			time.Sleep(300 * time.Millisecond)
		}
		if err := os.Rename(tmp, dst); err == nil {
			return nil
		}
		// dst is locked. A running image, or a file under an active scan, cannot be written or deleted --
		// but it can be renamed.
		aside := dst + supersededSuffix
		_ = os.Remove(aside) // a previous aside copy may itself still be running; ignore
		if err := os.Rename(dst, aside); err != nil {
			lastErr = err
			continue
		}
		if err := os.Rename(tmp, dst); err != nil {
			// Put the original back rather than leaving bin\ without this tool at all.
			_ = os.Rename(aside, dst)
			lastErr = err
			continue
		}
		// Best effort: this fails while the old image is still executing, and the sweep catches it on the
		// next run.
		_ = os.Remove(aside)
		return nil
	}
	_ = os.Remove(tmp)
	return fmt.Errorf("cannot put %s in place after 10 attempts over 3s (locked by a running copy or a scanner?): %w",
		dst, lastErr)
}

// sweepSupersededBinaries removes aside copies left by an earlier replacement. Failures are expected and
// ignored: a copy that is still running cannot be deleted yet, and will be caught next time.
func sweepSupersededBinaries(binDir string) {
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), supersededSuffix) || strings.HasSuffix(e.Name(), ".new") {
			_ = os.Remove(filepath.Join(binDir, e.Name()))
		}
	}
}

// stopOwnedServer stops a server this installation started, and does nothing at all otherwise.
//
// Returns exitRelease when there is nothing of ours to stop, which callers treat as success: "no server
// was running" and "the server was stopped" are both fine outcomes for an activation.
func stopOwnedServer(tree layout.Tree) int {
	state, err := serverstate.Read(tree.State())
	if err != nil {
		// No record, but something may still be listening. This is the orphaned case: an uninstall
		// removes state\ before bin\, so between those two steps a running server of ours has no record
		// at all -- and leaving it running is what made a following reinstall abort on a locked
		// executable during the RC1 rehearsal.
		return stopOrphanedServer(tree)
	}
	releaseID, _ := tree.ActiveRelease()

	if err := serverstate.RequestShutdown(canonicalOrigin, state.ShutdownToken); err == nil {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if !serverstate.PortOccupied(canonicalHostPort) {
				_ = serverstate.Clear(tree.State())
				return exitOK
			}
			time.Sleep(150 * time.Millisecond)
		}
	}

	// The identity here may name the release that is being replaced rather than the one now in
	// current.txt, so try both. Terminate re-proves the identity itself; passing the recorded release is
	// what lets a legitimate upgrade stop the old server.
	for _, id := range []string{state.Identity.ReleaseID, releaseID} {
		if id == "" {
			continue
		}
		if err := winproc.Terminate(state.Identity, tree.Root, id); err == nil {
			_ = serverstate.Clear(tree.State())
			return exitOK
		}
	}
	if !winproc.Alive(state.Identity.PID) {
		_ = serverstate.Clear(tree.State())
		return exitOK
	}
	fmt.Fprintf(os.Stderr,
		"error: a server is running that cannot be proven to belong to this installation; it was left alone\n")
	return exitInternal
}

// stopOrphanedServer stops a server that is provably ours but has no state file.
//
// Ownership is established without the record: the health endpoint reports the PID, the executable path
// and the installation root it belongs to, and the live process is then inspected to confirm it really is
// that PID running that executable. Both halves are needed -- the endpoint alone could be any program
// willing to return the right JSON, and the process alone says nothing about what it is serving. Together
// they are the same four facts the recorded identity carries, reconstructed from the two sources that
// cannot both be wrong at once.
//
// Anything that fails to satisfy that is left alone, exactly as a mismatched record would be.
func stopOrphanedServer(tree layout.Tree) int {
	if !serverstate.PortOccupied(canonicalHostPort) {
		return exitRelease
	}
	probe := serverstate.ProbeHealth(canonicalOrigin)
	if probe.Err != nil || probe.Health.Application != "civic-work-desk" {
		fmt.Fprintf(os.Stderr,
			"error: %s is held by something that is not CivicWorkDesk; it was left alone\n", canonicalHostPort)
		return exitInternal
	}
	if !strings.EqualFold(filepath.Clean(probe.Health.InstallRoot), filepath.Clean(tree.Root)) {
		fmt.Fprintf(os.Stderr,
			"error: the server on %s belongs to installation %q, not %q; it was left alone\n",
			canonicalHostPort, probe.Health.InstallRoot, tree.Root)
		return exitInternal
	}
	exe, creation, err := winproc.Inspect(probe.Health.PID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot inspect pid %d: %v\n", probe.Health.PID, err)
		return exitInternal
	}
	id := winproc.Identity{
		PID:          probe.Health.PID,
		ExePath:      exe,
		CreationTime: creation,
		InstallRoot:  tree.Root,
		ReleaseID:    probe.Health.ReleaseID,
		Origin:       canonicalOrigin,
	}
	if err := winproc.Terminate(id, tree.Root, probe.Health.ReleaseID); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}
	fmt.Printf("stopped an orphaned server (pid %d, release %s) whose state file had already been removed\n",
		id.PID, id.ReleaseID)
	return exitOK
}

// waitForBinariesReleasable waits until every binary in bin\ can be opened for writing.
//
// A process that has exited still holds its image for a moment while the kernel tears the section down.
// During that window the file can be neither written nor deleted, and an installer that copies over it
// fails -- silently, with /SUPPRESSMSGBOXES, as exit code 5. So "the service is stopped" is not a useful
// promise unless it also means "and its files can now be replaced", which is what this waits for.
func waitForBinariesReleasable(binDir string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		locked := ""
		for _, name := range binaries {
			path := filepath.Join(binDir, name)
			if _, err := os.Stat(path); err != nil {
				continue
			}
			f, err := os.OpenFile(path, os.O_WRONLY, 0o755)
			if err != nil {
				locked = name
				break
			}
			_ = f.Close()
		}
		if locked == "" {
			return true
		}
		if time.Now().After(deadline) {
			fmt.Fprintf(os.Stderr, "warning: %s is still locked after %s\n", locked, timeout)
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func startDetached(exe string, args ...string) (*os.Process, error) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
		HideWindow:    true,
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd.Process, nil
}

// runServerVersion proves the bundled executable can actually execute on this machine, which a digest
// check cannot: a correct file still fails to run if a policy blocks it or the architecture is wrong.
func runServerVersion(exe string) (string, error) {
	cmd := exec.Command(exe, "--help")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	// flag.Parse exits 2 on --help, so a non-zero status here is expected. What matters is that the
	// process ran at all and produced its own usage text.
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return "", err
	}
	text := out.String()
	if text == "" {
		return "", errors.New("the executable produced no output; it may be blocked from running")
	}
	return "the bundled executable runs and reports its own usage", nil
}

// redactUserPaths keeps the account name out of a preflight report, which is written to the Desktop
// and forwarded by an ordinary colleague. See internal/redact for what it does and does not touch.
func redactUserPaths(text string) string { return redact.Paths(text) }

func probeWritable(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	probe := filepath.Join(dir, fmt.Sprintf(".civic-preflight-%d.tmp", os.Getpid()))
	if err := os.WriteFile(probe, []byte("probe"), 0o644); err != nil {
		return err
	}
	return os.Remove(probe)
}

// userPrograms returns the per-user Start Menu Programs directory.
//
// %APPDATA%\Microsoft\Windows\Start Menu\Programs rather than the machine-wide one: a per-user
// installation must never write to the all-users Start Menu, which needs elevation.
func userPrograms() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return ""
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs")
}

var (
	ntdll             = syscall.NewLazyDLL("ntdll.dll")
	procRtlGetVersion = ntdll.NewProc("RtlGetVersion")
)

type osVersionInfoEx struct {
	OSVersionInfoSize uint32
	MajorVersion      uint32
	MinorVersion      uint32
	BuildNumber       uint32
	PlatformID        uint32
	CSDVersion        [128]uint16
	ServicePackMajor  uint16
	ServicePackMinor  uint16
	SuiteMask         uint16
	ProductType       byte
	Reserved          byte
}

// windowsVersion reads the real version through RtlGetVersion.
//
// GetVersionEx lies: since Windows 8.1 it reports 6.2 to any program without a compatibility manifest,
// so a check built on it would report Windows 8 on a Windows 11 machine and block every install.
// RtlGetVersion is not subject to that shimming.
func windowsVersion() (major int, build int) {
	info := osVersionInfoEx{}
	info.OSVersionInfoSize = uint32(unsafe.Sizeof(info))
	r, _, _ := procRtlGetVersion.Call(uintptr(unsafe.Pointer(&info)))
	if r != 0 {
		return 0, 0
	}
	return int(info.MajorVersion), int(info.BuildNumber)
}
