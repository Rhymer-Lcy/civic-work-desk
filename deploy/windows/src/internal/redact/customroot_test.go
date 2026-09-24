package redact

import (
	"strings"
	"testing"
)

// The paths a real user might actually choose. RC2 emitted these verbatim on the stated grounds that a
// custom directory "identifies nobody" — which is plainly false for every one of them, and is the reason
// this whole mechanism exists.
var identityPaths = []string{
	`D:\Alice\CivicWorkDesk`,
	`D:\张三\政务工作记录台`,
	`D:\某单位\李某\CivicWorkDesk`,
	`D:\Users\Alice\CivicWorkDesk`,
	`E:\HR\李某某的电脑\CivicWorkDesk`,
}

// The name fragments that must never survive. Each is a substring of one of the paths above.
var identityFragments = []string{"Alice", "张三", "某单位", "李某", "HR", "李某某"}

func setUp(t *testing.T) {
	t.Helper()
	ResetForTest()
	t.Cleanup(ResetForTest)
	t.Setenv("USERPROFILE", `C:\Users\Operator`)
	t.Setenv("LOCALAPPDATA", `C:\Users\Operator\AppData\Local`)
	t.Setenv("APPDATA", `C:\Users\Operator\AppData\Roaming`)
	t.Setenv("USERNAME", "Operator")
}

func TestCustomRootIsMaskedToItsVolume(t *testing.T) {
	for _, root := range identityPaths {
		ResetForTest()
		MaskInstallRoot(root)
		got := Paths(root)
		want := root[:2] + `\` + CustomRootPlaceholder
		if got != want {
			t.Errorf("Paths(%q) = %q, want %q", root, got, want)
		}
	}
}

// The root does not only appear as a field of its own. It is a prefix of the server executable path, the
// document root, the log file, and of every error string that mentions any of them — so the masking has
// to hold wherever it turns up, not only where it was expected.
func TestCustomRootIsMaskedWhereverItAppears(t *testing.T) {
	setUp(t)
	root := `D:\某单位\李某\CivicWorkDesk`
	MaskInstallRoot(root)

	samples := []string{
		root + `\bin\civic-server.exe`,
		root + `\releases\2026.09.24-win-rc3\app\index.html`,
		`cannot rename ` + root + `\bin\a.exe to ` + root + `\bin\b.exe`,
		`open ` + strings.ReplaceAll(root, `\`, `/`) + `/state/server.json: denied`,
		`{"installRoot":"` + strings.ReplaceAll(root, `\`, `\\`) + `"}`,
		strings.ToUpper(root) + `\LOGS\SERVER.LOG`,
	}
	for _, sample := range samples {
		got := Paths(sample)
		for _, fragment := range identityFragments {
			if strings.Contains(got, fragment) {
				t.Errorf("Paths(%q) left %q in %q", sample, fragment, got)
			}
		}
		if !strings.Contains(got, CustomRootPlaceholder) {
			t.Errorf("Paths(%q) = %q; the placeholder is missing", sample, got)
		}
	}
}

// A custom root inside the user profile is the nastiest case: two rules match, and applying the shorter
// one first would leave the chosen directory names behind under a %USERPROFILE% prefix.
func TestCustomRootInsideTheProfileStillMasks(t *testing.T) {
	setUp(t)
	root := `C:\Users\Operator\Documents\张三\CivicWorkDesk`
	MaskInstallRoot(root)
	got := Paths(root + `\bin\civic-launch.exe`)
	if strings.Contains(got, "张三") {
		t.Fatalf("the chosen directory survived: %q", got)
	}
	if strings.Contains(got, "Operator") {
		t.Errorf("the account name survived: %q", got)
	}
}

// The default location must NOT be turned into the placeholder: %LOCALAPPDATA% is more informative and
// already carries no identity, and losing the distinction would make every installation look custom.
func TestDefaultRootIsNotMasked(t *testing.T) {
	setUp(t)
	root := `C:\Users\Operator\AppData\Local\CivicWorkDesk`
	MaskInstallRoot(root)
	got := Paths(root)
	if got != `%LOCALAPPDATA%\CivicWorkDesk` {
		t.Errorf("Paths(default) = %q, want %%LOCALAPPDATA%%\\CivicWorkDesk", got)
	}
	if strings.Contains(got, CustomRootPlaceholder) {
		t.Error("the default location was reported as a custom root")
	}
}

func TestRootKind(t *testing.T) {
	setUp(t)
	if got := RootKind(`C:\Users\Operator\AppData\Local\CivicWorkDesk`); !strings.HasPrefix(got, "default") {
		t.Errorf("RootKind(default) = %q", got)
	}
	for _, root := range identityPaths {
		if got := RootKind(root); got != "custom" {
			t.Errorf("RootKind(%q) = %q, want custom", root, got)
		}
	}
}

// The characteristics are what replaces the path. They have to be useful enough to diagnose a
// custom-path problem, and they must not name anything.
func TestDescribeIsUsefulAndAnonymous(t *testing.T) {
	cases := map[string]Characteristics{
		`D:\Applications\CivicWorkDesk`:   {Volume: "D:", HasSpaces: false, HasNonASCII: false, Depth: 2, Length: 29},
		`D:\政务工作记录台`:                      {Volume: "D:", HasSpaces: false, HasNonASCII: true, Depth: 1, Length: 10},
		`E:\Program Folder\CivicWorkDesk`: {Volume: "E:", HasSpaces: true, HasNonASCII: false, Depth: 2, Length: 31},
		`D:\某单位\李某\CivicWorkDesk`:         {Volume: "D:", HasSpaces: false, HasNonASCII: true, Depth: 3, Length: 21},
	}
	for path, want := range cases {
		got := Describe(path)
		if got.Volume != want.Volume || got.HasSpaces != want.HasSpaces ||
			got.HasNonASCII != want.HasNonASCII || got.Depth != want.Depth {
			t.Errorf("Describe(%q) = %+v, want %+v", path, got, want)
		}
		// Whatever it reports, no field may carry a directory name.
		rendered := got.Volume
		for _, fragment := range identityFragments {
			if strings.Contains(rendered, fragment) {
				t.Errorf("Describe(%q) leaked %q", path, fragment)
			}
		}
	}
}

// Without this, every assertion above could pass on a redactor that simply deleted everything.
func TestMaskingIsNotJustDeletingEverything(t *testing.T) {
	setUp(t)
	MaskInstallRoot(`D:\Alice\CivicWorkDesk`)
	text := `release 2026.09.24-win-rc3 serving on http://127.0.0.1:8765 from D:\Alice\CivicWorkDesk\releases`
	got := Paths(text)
	for _, keep := range []string{"2026.09.24-win-rc3", "http://127.0.0.1:8765", "releases", "D:"} {
		if !strings.Contains(got, keep) {
			t.Errorf("redaction destroyed %q: %q", keep, got)
		}
	}
	if strings.Contains(got, "Alice") {
		t.Errorf("Alice survived: %q", got)
	}
}
