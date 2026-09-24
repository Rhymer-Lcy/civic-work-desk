//go:build windows

package winproc

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestInspectSelf(t *testing.T) {
	exe, creation, err := Inspect(syscall.Getpid())
	if err != nil {
		t.Fatalf("Inspect(self) failed: %v", err)
	}
	if creation == 0 {
		t.Error("creation time is zero; the PID-reuse token would be useless")
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(exe, self) {
		t.Errorf("Inspect(self) returned %q, want %q", exe, self)
	}
}

func TestInspectDeadPID(t *testing.T) {
	// Start something trivial, let it exit, then inspect its PID. On a machine this quiet the number
	// is very unlikely to be reused within the test, so this exercises the ErrNotFound path.
	cmd := exec.Command("cmd.exe", "/c", "exit", "0")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a long-lived helper process: %v", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Wait()
	if _, _, err := Inspect(pid); err == nil {
		t.Skip("the PID was reused or the handle outlived the process; cannot assert on this run")
	}
}

func TestInspectRejectsIllegalPID(t *testing.T) {
	for _, pid := range []int{0, -1, -4242} {
		if _, _, err := Inspect(pid); err == nil {
			t.Errorf("Inspect(%d) returned no error", pid)
		}
	}
}

func TestVerifyDetectsCreationTimeMismatch(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, creation, err := Inspect(syscall.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	good := Identity{PID: syscall.Getpid(), ExePath: self, CreationTime: creation}
	if ok, why := Verify(good); !ok {
		t.Fatalf("Verify rejected a correct identity: %s", why)
	}

	// This is the whole point of the package: a correct PID with the wrong creation time is a
	// different process, and must be refused.
	stale := good
	stale.CreationTime = creation - 1
	ok, why := Verify(stale)
	if ok {
		t.Fatal("Verify accepted an identity whose creation time does not match; PID reuse would terminate an unrelated process")
	}
	if !strings.Contains(why, "creation time") {
		t.Errorf("the refusal does not say why: %q", why)
	}
}

func TestVerifyDetectsExeMismatch(t *testing.T) {
	_, creation, err := Inspect(syscall.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	wrong := Identity{
		PID:          syscall.Getpid(),
		ExePath:      filepath.Join(os.Getenv("SystemRoot"), "System32", "notepad.exe"),
		CreationTime: creation,
	}
	ok, why := Verify(wrong)
	if ok {
		t.Fatal("Verify accepted an identity naming a different executable")
	}
	if !strings.Contains(why, "runs") {
		t.Errorf("the refusal does not say why: %q", why)
	}
}

func TestVerifyOwnedRequiresInstallScope(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, creation, err := Inspect(syscall.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(self)
	id := Identity{
		PID:          syscall.Getpid(),
		ExePath:      self,
		CreationTime: creation,
		InstallRoot:  root,
		ReleaseID:    "2026.09.24-win-rc1",
	}
	if ok, why := VerifyOwned(id, root, "2026.09.24-win-rc1"); !ok {
		t.Fatalf("VerifyOwned rejected a correct identity: %s", why)
	}
	if ok, _ := VerifyOwned(id, root, "2026.09.24-win-rc2"); ok {
		t.Error("VerifyOwned accepted a different release id")
	}
	if ok, _ := VerifyOwned(id, filepath.Join(root, "elsewhere"), "2026.09.24-win-rc1"); ok {
		t.Error("VerifyOwned accepted a different install root")
	}

	// An executable outside the installation must never be terminable, however well the other facts
	// line up. This is the check that stops a corrupted or planted state file from authorising a kill.
	outside := id
	outside.InstallRoot = filepath.Join(root, "sub")
	if ok, why := VerifyOwned(outside, filepath.Join(root, "sub"), "2026.09.24-win-rc1"); ok {
		t.Error("VerifyOwned accepted an executable outside the install root")
	} else if !strings.Contains(why, "not inside") {
		t.Errorf("the refusal does not say why: %q", why)
	}
}

// startStagedHelper copies a real, long-lived executable into a fake installation root and starts it,
// so a refusal can be attributed to the ONE fact the case perturbs rather than to the executable
// simply being outside the tree.
//
// Without this, every case below refuses for the same reason -- withinTree fails for
// System32\cmd.exe against a temp root -- and the creation-time and exe-path checks are never
// exercised at all while all three assertions pass.
func startStagedHelper(t *testing.T) (root string, pid int, exe string, creation int64) {
	t.Helper()
	root = t.TempDir()
	src := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	dst := filepath.Join(root, "civic-server.exe")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("cannot read %s: %v", src, err)
	}
	if err := os.WriteFile(dst, data, 0o755); err != nil {
		t.Skipf("cannot stage a helper executable: %v", err)
	}
	helper := exec.Command(dst, "/c", "ping", "-n", "60", "127.0.0.1")
	if err := helper.Start(); err != nil {
		t.Skipf("cannot start the staged helper: %v", err)
	}
	pid = helper.Process.Pid
	t.Cleanup(func() {
		_ = helper.Process.Kill()
		_, _ = helper.Process.Wait()
	})
	time.Sleep(200 * time.Millisecond)
	exe, creation, err = Inspect(pid)
	if err != nil {
		t.Skipf("cannot inspect the staged helper: %v", err)
	}
	return root, pid, exe, creation
}

// Terminate must refuse rather than kill when ownership cannot be proven. It is aimed at a real, live
// process to make the consequence of a wrong answer concrete: if this test ever fails, it failed by
// killing something.
func TestTerminateRefusesUnprovenProcess(t *testing.T) {
	root, pid, exe, creation := startStagedHelper(t)

	// The baseline must be terminable, or every refusal below could be an artefact of the fixture
	// rather than of the check under test. Asserted without terminating: VerifyOwned is the predicate
	// Terminate gates on.
	base := Identity{PID: pid, ExePath: exe, CreationTime: creation,
		InstallRoot: root, ReleaseID: "2026.09.24-win-rc1"}
	if ok, why := VerifyOwned(base, root, "2026.09.24-win-rc1"); !ok {
		t.Fatalf("the fixture itself is not provably owned (%s); the refusals below would prove nothing", why)
	}

	cases := []struct {
		name       string
		id         Identity
		root       string
		release    string
		wantReason string
	}{
		{"creation time reused", Identity{PID: pid, ExePath: exe, CreationTime: creation - 1,
			InstallRoot: root, ReleaseID: "2026.09.24-win-rc1"}, root, "2026.09.24-win-rc1",
			"creation time"},
		{"different executable", Identity{PID: pid, ExePath: filepath.Join(root, "something-else.exe"),
			CreationTime: creation, InstallRoot: root, ReleaseID: "2026.09.24-win-rc1"}, root,
			"2026.09.24-win-rc1", "runs"},
		{"executable outside the install root", Identity{PID: pid,
			ExePath:      filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe"),
			CreationTime: creation, InstallRoot: root, ReleaseID: "2026.09.24-win-rc1"}, root,
			"2026.09.24-win-rc1", "not inside"},
		{"different release", base, root, "2026.09.24-win-rc2", "not to"},
		{"different install root", base, filepath.Join(root, "other"), "2026.09.24-win-rc1", "not to"},
		{"pid is not a pid", Identity{PID: 0, ExePath: exe, CreationTime: creation,
			InstallRoot: root, ReleaseID: "2026.09.24-win-rc1"}, root, "2026.09.24-win-rc1",
			"not a pid"},
	}
	for _, c := range cases {
		err := Terminate(c.id, c.root, c.release)
		if err == nil {
			t.Fatalf("%s: Terminate did NOT refuse, and has just killed a process it could not prove it owned", c.name)
		}
		if !strings.Contains(err.Error(), "refusing to terminate") {
			t.Errorf("%s: refusal is not explicit: %v", c.name, err)
		}
		// The refusal must name the fact that failed, or a future change could pass this test while
		// checking something else entirely.
		if !strings.Contains(err.Error(), c.wantReason) {
			t.Errorf("%s: refusal does not cite %q: %v", c.name, c.wantReason, err)
		}
		if !Alive(pid) {
			t.Fatalf("%s: the process is dead; Terminate killed it despite returning an error", c.name)
		}
	}
}

// Terminate must actually work when ownership IS proven, or the refusals above would be
// indistinguishable from a function that never terminates anything.
func TestTerminateStopsAnOwnedProcess(t *testing.T) {
	root, pid, exe, creation := startStagedHelper(t)
	id := Identity{PID: pid, ExePath: exe, CreationTime: creation,
		InstallRoot: root, ReleaseID: "2026.09.24-win-rc1"}

	if err := Terminate(id, root, "2026.09.24-win-rc1"); err != nil {
		t.Fatalf("Terminate refused a provably owned process: %v", err)
	}
	if Alive(pid) {
		t.Error("Terminate returned success but the process is still alive")
	}
}

func TestSamePathAndWithinTree(t *testing.T) {
	if !samePath(`C:\A\B`, `C:\a\b`) {
		t.Error("samePath is case sensitive; Windows paths are not")
	}
	if !samePath(`C:\A\B`, `C:\A\.\B`) {
		t.Error("samePath does not clean its inputs")
	}
	if !withinTree(`C:\A\B\c.exe`, `C:\A\B`) {
		t.Error("withinTree rejected a real child")
	}
	if !withinTree(`C:\A\B`, `C:\A\B`) {
		t.Error("withinTree rejected the root itself")
	}
	// The trap this guard exists for: a sibling whose name merely starts with the root's name.
	if withinTree(`C:\A\CivicWorkDeskOther\x.exe`, `C:\A\CivicWorkDesk`) {
		t.Error("withinTree accepted a sibling directory sharing a name prefix")
	}
	if withinTree(`C:\Other\x.exe`, `C:\A\CivicWorkDesk`) {
		t.Error("withinTree accepted an unrelated path")
	}
	if withinTree("", `C:\A`) || withinTree(`C:\A`, "") {
		t.Error("withinTree accepted an empty path")
	}
}

func TestDefaultBrowserProgIDIsReadOnly(t *testing.T) {
	// Absence is a valid answer on a machine with no UserChoice set; the point is that asking cannot
	// fail destructively and returns something reportable either way.
	progID, err := DefaultBrowserProgID()
	if err != nil {
		t.Logf("no default http handler recorded: %v", err)
		return
	}
	if strings.TrimSpace(progID) == "" {
		t.Error("DefaultBrowserProgID returned an empty string with no error")
	}
	t.Logf("default http handler ProgId = %q", progID)
}
