// Command civic-admin is the installer's and uninstaller's side of the deployment.
//
//	civic-admin.exe preflight --root <dir> [--release <id>]   check before anything destructive
//	civic-admin.exe activate  --root <dir> --release <id>     verify, then point current.txt at it
//	civic-admin.exe verify    --root <dir> [--release <id>]   check a release against its manifest
//	civic-admin.exe rollback  --root <dir>                    swap current.txt back to previous.txt
//	civic-admin.exe deactivate --root <dir>                   stop the server; leave records alone
//
// ## The ordering that makes failure safe
//
// The installer extracts a release into releases\<id>\ and only then calls activate. Extraction into a
// new directory is inherently a staging step: while it runs, current.txt still names the previous
// release, and every shortcut still works. Activation is one rename of one small file, done after the
// payload has been verified against its own manifest and after the server has been shown to bind and
// answer. So a failure at any point before that rename leaves a working installation, and there is no
// window in which current.txt names something unusable.
//
// This is the Windows form of the Phase-3 lesson: the corrective pass there existed because activation
// happened before verification, and because the pointer update could land somewhere other than where it
// was supposed to.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"civicworkdesk/windows/internal/httpserve"
	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/release"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

const (
	canonicalOrigin   = "http://127.0.0.1:8765"
	canonicalHostPort = "127.0.0.1:8765"
	serverExeName     = "civic-server.exe"
	lockFileName      = "install.lock"
)

const (
	exitOK       = 0
	exitUsage    = 2
	exitPortBusy = 3
	exitRelease  = 4
	exitInternal = 5
	exitBusy     = 6
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(exitUsage)
	}
	command := os.Args[1]
	fs := flag.NewFlagSet(command, flag.ExitOnError)
	root := fs.String("root", "", "installation root")
	releaseID := fs.String("release", "", "release id")
	reportPath := fs.String("report", "", "write a preflight report to this file")
	_ = fs.Parse(os.Args[2:])

	tree, err := resolveTree(*root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(exitUsage)
	}

	// The installer runs this program hidden, so anything it prints is otherwise lost -- which is exactly
	// how a failed activation came back as a bare "exit code 5" during the first install rehearsal. The
	// transcript makes every run explain itself in a file the diagnostics tool collects.
	//
	// os.Exit skips deferred functions, so the transcript is closed explicitly on every path.
	stopTranscript := startTranscript(tree.Logs())
	finish := func(code int) {
		stopTranscript()
		os.Exit(code)
	}

	switch command {
	case "preflight":
		finish(cmdPreflight(tree, *releaseID, *reportPath))
	case "activate":
		finish(cmdActivate(tree, *releaseID))
	case "verify":
		finish(cmdVerify(tree, *releaseID))
	case "rollback":
		finish(cmdRollback(tree))
	case "deactivate":
		finish(cmdDeactivate(tree))
	default:
		fmt.Fprintf(os.Stderr, "error: unknown command %q\n", command)
		usage()
		finish(exitUsage)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr,
		"usage: civic-admin.exe <preflight|activate|verify|rollback|deactivate> --root <dir> [--release <id>]")
}

func resolveTree(root string) (layout.Tree, error) {
	if root == "" {
		return layout.Default()
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return layout.Tree{}, fmt.Errorf("cannot resolve --root %q: %w", root, err)
	}
	return layout.At(abs), nil
}

// check is one preflight line. The taxonomy is the same as the Stage-A probe's, because the installer's
// preflight replaces that probe for ordinary testers and its output has to be comparable.
type check struct {
	Name   string
	Status string // PASS, FAIL, PRESENT, NOT PRESENT, IN USE, INFO
	Detail string
}

func (c check) String() string { return fmt.Sprintf("[%-11s] %-34s %s", c.Status, c.Name, c.Detail) }

// blocking reports whether this result should stop the installation.
func (c check) blocking() bool { return c.Status == "FAIL" || c.Status == "IN USE" }

func cmdPreflight(tree layout.Tree, releaseID, reportPath string) int {
	var checks []check
	add := func(name, status, detail string) {
		checks = append(checks, check{name, status, detail})
	}

	// --- the platform ---------------------------------------------------------------------------
	major, build := windowsVersion()
	if major >= 10 && build >= 22000 {
		add("Windows 11", "PASS", fmt.Sprintf("build %d", build))
	} else {
		add("Windows 11", "FAIL",
			fmt.Sprintf("build %d; CivicWorkDesk RC1 targets Windows 11 (build 22000 or later)", build))
	}
	if arch := os.Getenv("PROCESSOR_ARCHITECTURE"); strings.EqualFold(arch, "AMD64") {
		add("x64 architecture", "PASS", arch)
	} else {
		add("x64 architecture", "FAIL",
			fmt.Sprintf("PROCESSOR_ARCHITECTURE=%s; this build is x64 only", arch))
	}

	// --- the places we must be able to write ----------------------------------------------------
	for _, spec := range []struct{ name, dir string }{
		{"LOCALAPPDATA writable", os.Getenv("LOCALAPPDATA")},
		{"install root usable", tree.Root},
		{"Start Menu writable", userPrograms()},
	} {
		if spec.dir == "" {
			add(spec.name, "FAIL", "the location could not be determined")
			continue
		}
		if err := probeWritable(spec.dir); err != nil {
			add(spec.name, "FAIL", fmt.Sprintf("%s (%v)", spec.dir, err))
		} else {
			add(spec.name, "PASS", spec.dir)
		}
	}

	// --- the release, if one was named ----------------------------------------------------------
	id := releaseID
	if id == "" {
		if active, err := tree.ActiveRelease(); err == nil {
			id = active
		}
	}
	if id == "" {
		add("release to check", "NOT PRESENT", "no release id given and none is active yet")
	} else {
		add("release id", "INFO", id)
		if err := tree.AssertReleaseShape(id); err != nil {
			add("release shape", "FAIL", err.Error())
		} else {
			add("release shape", "PASS", "app, server, VERSION, SHA256SUMS.txt and nothing else")
		}
		dir, err := tree.Release(id)
		if err != nil {
			add("release directory", "FAIL", err.Error())
		} else if res, err := release.Verify(dir); err != nil {
			add("payload integrity", "FAIL", err.Error())
		} else if !res.OK() {
			add("payload integrity", "FAIL", res.Summary())
		} else {
			add("payload integrity", "PASS", res.Summary())
			checks = append(checks, payloadServableChecks(dir)...)
		}
		if exe := releaseServerExe(tree, id); exe == "" {
			add("bundled server present", "FAIL", serverExeName+" is not in the release")
		} else if out, err := runServerVersion(exe); err != nil {
			add("bundled server runs", "FAIL", fmt.Sprintf("%s: %v", exe, err))
		} else {
			add("bundled server runs", "PASS", strings.TrimSpace(out))
		}
	}

	// --- the port -------------------------------------------------------------------------------
	checks = append(checks, portChecks(tree, id)...)

	// --- report ---------------------------------------------------------------------------------
	blocking := 0
	for _, c := range checks {
		if c.blocking() {
			blocking++
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CivicWorkDesk Windows RC1 -- installation preflight\n\n")
	fmt.Fprintf(&b, "collected       : %s\n", time.Now().Format(time.RFC3339))
	fmt.Fprintf(&b, "install root    : %s\n", tree.Root)
	fmt.Fprintf(&b, "canonical origin: %s/\n\n", canonicalOrigin)
	fmt.Fprintf(&b, "STATUS: [PASS] [PRESENT] [NOT PRESENT] [IN USE] [INFO] [FAIL]\n")
	fmt.Fprintf(&b, "NOT PRESENT and INFO are not failures. FAIL and IN USE stop the installation.\n\n")
	for _, c := range checks {
		fmt.Fprintf(&b, "  %s\n", c)
	}
	fmt.Fprintf(&b, "\nblocking problems: %d\n", blocking)
	if blocking == 0 {
		fmt.Fprintf(&b, "RESULT: PASS -- this machine can run CivicWorkDesk RC1.\n")
	} else {
		fmt.Fprintf(&b, "RESULT: BLOCKED -- see the [FAIL] and [IN USE] lines above.\n")
	}
	out := b.String()
	fmt.Print(out)

	if reportPath != "" {
		if err := os.MkdirAll(filepath.Dir(reportPath), 0o755); err == nil {
			// UTF-8 with a BOM: the file exists to be opened by a colleague in Notepad and forwarded, and
			// without the BOM a Chinese-locale Notepad can still guess the code page wrongly.
			_ = os.WriteFile(reportPath, append([]byte{0xEF, 0xBB, 0xBF}, []byte(out)...), 0o644)
		}
	}
	if blocking > 0 {
		return exitRelease
	}
	return exitOK
}

// payloadServableChecks confirms the payload is one this server can actually serve correctly, rather
// than merely one whose digests match.
func payloadServableChecks(releaseDir string) []check {
	var out []check
	appDir := filepath.Join(releaseDir, "app")
	if _, err := os.Stat(filepath.Join(appDir, "index.html")); err != nil {
		return []check{{"app/index.html", "FAIL", err.Error()}}
	}
	out = append(out, check{"app/index.html", "PRESENT", ""})

	entries, err := release.ReadManifest(releaseDir)
	if err != nil {
		return append(out, check{"manifest readable", "FAIL", err.Error()})
	}
	var unknown []string
	var reserved []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Path, "app/") {
			continue
		}
		if _, known := httpserve.ContentTypeFor(e.Path); !known {
			unknown = append(unknown, e.Path)
		}
		// A payload file under the reserved namespace would be shadowed by the generated endpoints and
		// could never be served. Catch it here rather than letting it silently 404 in the field.
		if strings.HasPrefix("/"+strings.TrimPrefix(e.Path, "app"), httpserve.ReservedPrefix) {
			reserved = append(reserved, e.Path)
		}
	}
	if len(unknown) > 0 {
		out = append(out, check{"every file has a MIME type", "FAIL",
			fmt.Sprintf("no content type for %v", unknown)})
	} else {
		out = append(out, check{"every file has a MIME type", "PASS",
			fmt.Sprintf("%d payload file(s)", len(entries))})
	}
	if len(reserved) > 0 {
		out = append(out, check{"no file shadows /__civic/", "FAIL", fmt.Sprintf("%v", reserved)})
	} else {
		out = append(out, check{"no file shadows /__civic/", "PASS", ""})
	}
	return out
}

// portChecks answers the two questions about 8765 that have different consequences: is it free, and if
// something holds it, is that something ours.
func portChecks(tree layout.Tree, releaseID string) []check {
	if !serverstate.PortOccupied(canonicalHostPort) {
		return []check{{"port 8765", "PASS", "free"}}
	}
	probe := serverstate.ProbeHealth(canonicalOrigin)
	if probe.Err == nil && probe.Health.Application == "civic-work-desk" {
		ours := strings.EqualFold(filepath.Clean(probe.Health.InstallRoot), filepath.Clean(tree.Root))
		if ours {
			// Our own running server is not a blocker: an upgrade legitimately runs while the old
			// version is up, and the installer stops it before activating.
			return []check{{"port 8765", "PRESENT", fmt.Sprintf(
				"held by this installation's own server (release %s, pid %d); it will be stopped before activation",
				probe.Health.ReleaseID, probe.Health.PID)}}
		}
		return []check{{"port 8765", "IN USE", fmt.Sprintf(
			"held by another CivicWorkDesk installation at %s (release %s)",
			probe.Health.InstallRoot, probe.Health.ReleaseID)}}
	}
	return []check{{"port 8765", "IN USE",
		"held by a program that is not CivicWorkDesk; the canonical origin cannot be changed, so this must be freed first"}}
}

func cmdVerify(tree layout.Tree, releaseID string) int {
	id := releaseID
	if id == "" {
		var err error
		if id, err = tree.ActiveRelease(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			return exitRelease
		}
	}
	if err := tree.AssertReleaseShape(id); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitRelease
	}
	dir, err := tree.Release(id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitUsage
	}
	res, err := release.Verify(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitRelease
	}
	fmt.Printf("release %s: %s\n", id, res.Summary())
	if !res.OK() {
		return exitRelease
	}
	return exitOK
}

// cmdActivate is the one destructive step, and it is deliberately the last one.
func cmdActivate(tree layout.Tree, releaseID string) int {
	if releaseID == "" {
		fmt.Fprintln(os.Stderr, "error: activate needs --release")
		return exitUsage
	}
	if err := tree.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}

	// The install lock makes two concurrent installers impossible rather than unlikely. Two of them
	// both reporting success while one nested its payload inside the other is a defect that actually
	// shipped in Phase 3; the lock plus the shape assertion below are what close it.
	lock, err := winproc.AcquireLock(filepath.Join(tree.State(), lockFileName))
	if err != nil {
		if errors.Is(err, winproc.ErrLockBusy) {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			return exitBusy
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}
	defer lock.Release()

	if err := tree.AssertReleaseShape(releaseID); err != nil {
		fmt.Fprintf(os.Stderr, "error: refusing to activate: %v\n", err)
		return exitRelease
	}
	dir, err := tree.Release(releaseID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitUsage
	}
	res, err := release.Verify(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: refusing to activate: %v\n", err)
		return exitRelease
	}
	if !res.OK() {
		fmt.Fprintf(os.Stderr, "error: refusing to activate: %s\n", res.Summary())
		return exitRelease
	}
	fmt.Printf("verified: %s\n", res.Summary())

	// Stop whatever we own before repointing, so the browser cannot be handed a server that is serving
	// the previous release from a directory that is about to stop being current.
	if code := stopOwnedServer(tree); code != exitOK && code != exitRelease {
		return code
	}

	previous, prevErr := tree.ActiveRelease()
	sameVersion := prevErr == nil && previous == releaseID

	// Bind test before the rename. This is the check that turns "the files are correct" into "this
	// machine can actually serve them", and doing it before activation is what keeps a failure
	// non-destructive.
	if serverstate.PortOccupied(canonicalHostPort) {
		fmt.Fprintf(os.Stderr,
			"error: %s is occupied by something else; refusing to activate a release that cannot be served\n",
			canonicalHostPort)
		return exitPortBusy
	}

	if err := installBinaries(tree, releaseID); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}

	if sameVersion {
		// Same-version repair. The payload has just been verified byte for byte, so there is nothing to
		// overwrite and nothing to roll back; what a repair fixes is the things outside the release
		// directory -- bin\, the pointer files, a stale state file.
		fmt.Printf("release %s is already active; repaired the deployment around it\n", releaseID)
		if err := layout.WritePointer(tree.CurrentFile(), releaseID); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			return exitInternal
		}
		_ = serverstate.Clear(tree.State())
		return runIntegrationCheck(tree, releaseID)
	}

	if prevErr == nil {
		if err := layout.WritePointer(tree.PrevFile(), previous); err != nil {
			fmt.Fprintf(os.Stderr, "error: cannot record the rollback target: %v\n", err)
			return exitInternal
		}
	}
	if err := layout.WritePointer(tree.CurrentFile(), releaseID); err != nil {
		// The pointer write reads itself back, so reaching here means current.txt was NOT changed.
		fmt.Fprintf(os.Stderr, "error: activation failed and the previous version is still active: %v\n", err)
		return exitInternal
	}
	_ = serverstate.Clear(tree.State())
	fmt.Printf("activated release %s (previous: %s)\n", releaseID, orNone(previous, prevErr))
	return runIntegrationCheck(tree, releaseID)
}

// runIntegrationCheck starts the freshly activated server, proves it answers for the right release, and
// stops it again. Activation that has not been shown to serve is not activation, it is a hope.
func runIntegrationCheck(tree layout.Tree, releaseID string) int {
	exe := filepath.Join(tree.Bin(), serverExeName)
	if _, err := os.Stat(exe); err != nil {
		fmt.Fprintf(os.Stderr, "error: %s is missing after activation: %v\n", exe, err)
		return exitInternal
	}
	proc, err := startDetached(exe, "--root", tree.Root, "--release", releaseID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot start the server for the integration check: %v\n", err)
		return exitInternal
	}
	health, werr := serverstate.WaitUntilHealthy(canonicalOrigin, tree.Root, releaseID, 20*time.Second)
	if werr != nil {
		fmt.Fprintf(os.Stderr, "error: the activated release did not serve correctly: %v\n", werr)
		_ = proc.Kill()
		return exitInternal
	}
	fmt.Printf("integration check: %s serves release %s (pid %d)\n",
		canonicalOrigin, health.ReleaseID, health.PID)

	if code := stopOwnedServer(tree); code != exitOK {
		fmt.Fprintln(os.Stderr, "warning: the integration server could not be stopped cleanly")
	}
	return exitOK
}

func cmdRollback(tree layout.Tree) int {
	lock, err := winproc.AcquireLock(filepath.Join(tree.State(), lockFileName))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitBusy
	}
	defer lock.Release()

	previous, err := tree.PreviousRelease()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: there is no recorded previous release to roll back to: %v\n", err)
		return exitRelease
	}
	current, cerr := tree.ActiveRelease()
	if err := tree.AssertReleaseShape(previous); err != nil {
		fmt.Fprintf(os.Stderr, "error: refusing to roll back: %v\n", err)
		return exitRelease
	}
	dir, err := tree.Release(previous)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitUsage
	}
	if res, err := release.Verify(dir); err != nil || !res.OK() {
		fmt.Fprintf(os.Stderr, "error: refusing to roll back to a release that does not verify\n")
		return exitRelease
	}
	if code := stopOwnedServer(tree); code != exitOK && code != exitRelease {
		return code
	}
	if err := installBinaries(tree, previous); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}
	if cerr == nil {
		if err := layout.WritePointer(tree.PrevFile(), current); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			return exitInternal
		}
	}
	if err := layout.WritePointer(tree.CurrentFile(), previous); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return exitInternal
	}
	_ = serverstate.Clear(tree.State())

	// Rolling back changes the deployment payload only. The user's records live in browser storage at
	// the canonical origin and are not touched, moved or downgraded by this -- and no attempt is ever
	// made to migrate them backwards, because a browser database has no safe downgrade.
	fmt.Printf("rolled back to release %s (was %s). Browser-resident records are untouched.\n",
		previous, orNone(current, cerr))
	return runIntegrationCheck(tree, previous)
}

// cmdDeactivate is what the uninstaller calls first: stop the program, leave every record alone.
func cmdDeactivate(tree layout.Tree) int {
	code := stopOwnedServer(tree)
	// Do not return until the binaries can actually be replaced or deleted. The uninstaller removes bin\
	// immediately after this, and an installer run straight afterwards copies into it; both fail on an
	// image the kernel has not finished releasing, and with /SUPPRESSMSGBOXES that failure is a bare
	// exit code 5 with no explanation. Waiting here is what makes "stopped" mean "and its files are free".
	waitForBinariesReleasable(tree.Bin(), 15*time.Second)
	fmt.Println("CivicWorkDesk 的本地服务已停止。")
	fmt.Println("浏览器中保存的工作记录、备份文件和导出的文档都没有被删除。")
	if code == exitOK || code == exitRelease {
		return exitOK
	}
	return code
}

func orNone(value string, err error) string {
	if err != nil {
		return "none"
	}
	return value
}
