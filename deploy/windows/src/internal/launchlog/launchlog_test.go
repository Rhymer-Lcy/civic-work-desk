package launchlog

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestFormatIsOneLineWithAnOffset(t *testing.T) {
	at := time.Date(2026, 9, 29, 10, 12, 3, 0, time.FixedZone("UTC+8", 8*3600))
	line := Format(Entry{Time: at, Command: "open", Outcome: PortForeign, ExitCode: 3,
		Release: "2026.09.29-win-0.2.0-rc.1", Detail: "port 8765\nheld by\tsomething"})
	want := `2026-09-29T10:12:03+08:00 open outcome=port-conflict-foreign-program exit=3 ` +
		`release=2026.09.29-win-0.2.0-rc.1 detail="port 8765 held by something"`
	if line != want {
		t.Fatalf("got  %s\nwant %s", line, want)
	}
}

func TestAppendKeepsEveryLaunchAndRotatesOnce(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		if err := Append(dir, Entry{Time: time.Now(), Command: "open", Outcome: OK}); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(raw), "outcome=ok"); n != 3 {
		t.Fatalf("%d lines recorded, want 3", n)
	}

	// Past the cap, the file moves aside once and a fresh one starts.
	if err := os.WriteFile(filepath.Join(dir, FileName), make([]byte, maxBytes), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Append(dir, Entry{Time: time.Now(), Command: "open", Outcome: BrowserFailed}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(dir, FileName+".1")); err != nil || info.Size() != maxBytes {
		t.Fatalf("the full log was not rotated aside: %v", err)
	}
	fresh, _ := os.ReadFile(filepath.Join(dir, FileName))
	if !strings.Contains(string(fresh), "browser-launch-failed") || len(fresh) > 200 {
		t.Fatalf("the fresh log is wrong: %q", fresh)
	}
}

func TestClassifyStartError(t *testing.T) {
	cases := map[syscall.Errno]Outcome{
		1260: ServerBlockedPolicy,
		4551: ServerBlockedCI,
		4556: ServerBlockedCI,
		225:  ServerBlockedAV,
		226:  ServerBlockedAV,
		2:    ServerMissing,
		3:    ServerMissing,
		5:    ServerStartFailed,
		193:  ServerStartFailed,
	}
	for errno, want := range cases {
		// Wrapped the way os/exec wraps it, because that is what the launcher actually receives.
		wrapped := fmt.Errorf("cannot start: %w", &os.PathError{Op: "fork/exec", Path: "x", Err: errno})
		got, code := ClassifyStartError(wrapped)
		if got != want || code != errno {
			t.Errorf("errno %d: got %s/%d, want %s", errno, got, code, want)
		}
	}
	if got, _ := ClassifyStartError(fmt.Errorf("no errno here")); got != ServerStartFailed {
		t.Errorf("an error without an errno: got %s", got)
	}
}

// The real thing: starting a file that does not exist through os/exec yields an errno the classifier
// recognises as a missing executable -- the shape a quarantined civic-server.exe produces.
func TestClassifyARealMissingExecutable(t *testing.T) {
	cmd := exec.Command(filepath.Join(t.TempDir(), "civic-server.exe"))
	err := cmd.Start()
	if err == nil {
		_ = cmd.Process.Kill()
		t.Fatal("a missing executable started")
	}
	if got, code := ClassifyStartError(err); got != ServerMissing {
		t.Fatalf("got %s (errno %d) from %v", got, code, err)
	}
}
