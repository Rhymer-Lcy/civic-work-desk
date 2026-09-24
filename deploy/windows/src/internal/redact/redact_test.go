package redact

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withEnv(t *testing.T, pairs map[string]string) {
	t.Helper()
	for key, value := range pairs {
		t.Setenv(key, value)
	}
}

func TestRewritesKnownPrefixes(t *testing.T) {
	withEnv(t, map[string]string{
		"USERPROFILE":  `C:\Users\Alice`,
		"LOCALAPPDATA": `C:\Users\Alice\AppData\Local`,
		"APPDATA":      `C:\Users\Alice\AppData\Roaming`,
		"TEMP":         `C:\Users\Alice\AppData\Local\Temp`,
		"USERNAME":     "Alice",
	})

	cases := map[string]string{
		`C:\Users\Alice\AppData\Local\CivicWorkDesk\bin\civic-server.exe`: `%LOCALAPPDATA%\CivicWorkDesk\bin\civic-server.exe`,
		`C:\Users\Alice\Desktop\report.txt`:                               `%USERPROFILE%\Desktop\report.txt`,
		`C:\Users\Alice\AppData\Roaming\Microsoft`:                        `%APPDATA%\Microsoft`,
	}
	for input, want := range cases {
		if got := Paths(input); got != want {
			t.Errorf("Paths(%q) = %q, want %q", input, got, want)
		}
	}
}

// LOCALAPPDATA lives inside USERPROFILE. Replacing the shorter prefix first would yield
// %USERPROFILE%\AppData\Local\... and the more specific variable would never be used, so the ordering
// is asserted rather than assumed.
func TestLongestPrefixWins(t *testing.T) {
	withEnv(t, map[string]string{
		"USERPROFILE":  `C:\Users\Alice`,
		"LOCALAPPDATA": `C:\Users\Alice\AppData\Local`,
		"TEMP":         `C:\Users\Alice\AppData\Local\Temp`,
		"USERNAME":     "Alice",
	})
	got := Paths(`C:\Users\Alice\AppData\Local\Temp\civic.log`)
	if got != `%TEMP%\civic.log` {
		t.Errorf("got %q, want %%TEMP%%\\civic.log", got)
	}
}

func TestCaseInsensitiveAndKeepsRealCasing(t *testing.T) {
	withEnv(t, map[string]string{
		"LOCALAPPDATA": `C:\Users\Alice\AppData\Local`,
		"USERNAME":     "Alice",
	})
	// Windows hands back mixed casing constantly; the substitution must still fire, and the part that
	// is kept must not be lower-cased on the way through.
	got := Paths(`c:\users\alice\appdata\local\CivicWorkDesk\Bin\Civic-Server.exe`)
	if got != `%LOCALAPPDATA%\CivicWorkDesk\Bin\Civic-Server.exe` {
		t.Errorf("got %q", got)
	}
}

func TestForwardSlashFormIsAlsoRewritten(t *testing.T) {
	withEnv(t, map[string]string{
		"LOCALAPPDATA": `C:\Users\Alice\AppData\Local`,
		"USERNAME":     "Alice",
	})
	got := Paths(`open C:/Users/Alice/AppData/Local/CivicWorkDesk/state/server.json: denied`)
	if strings.Contains(got, "Alice") {
		t.Errorf("the forward-slash form was not rewritten: %q", got)
	}
}

// The whole point of the feature is that a custom directory stays diagnosable. A redactor that ate
// D:\Applications\CivicWorkDesk would make a custom-path installation impossible to support, which is
// worse than the identity it would be protecting.
func TestCustomInstallPathIsUntouched(t *testing.T) {
	withEnv(t, map[string]string{
		"USERPROFILE":  `C:\Users\Alice`,
		"LOCALAPPDATA": `C:\Users\Alice\AppData\Local`,
		"USERNAME":     "Alice",
	})
	for _, path := range []string{
		`D:\Applications\CivicWorkDesk\bin\civic-launch.exe`,
		`D:\政务工作记录台\current.txt`,
		`E:\Program Folder With Spaces\CivicWorkDesk`,
	} {
		if got := Paths(path); got != path {
			t.Errorf("Paths(%q) = %q; a path with no user identity must be left alone", path, got)
		}
	}
}

func TestMultipleOccurrencesInOneString(t *testing.T) {
	withEnv(t, map[string]string{
		"LOCALAPPDATA": `C:\Users\Alice\AppData\Local`,
		"USERNAME":     "Alice",
	})
	input := `cannot rename C:\Users\Alice\AppData\Local\a.exe to C:\Users\Alice\AppData\Local\b.exe`
	got := Paths(input)
	if strings.Contains(got, "Alice") {
		t.Errorf("not every occurrence was rewritten: %q", got)
	}
	if strings.Count(got, "%LOCALAPPDATA%") != 2 {
		t.Errorf("expected two substitutions, got %q", got)
	}
}

// A redactor that rewrote a drive root would turn every path on the volume into a variable, destroying
// the report to protect nothing.
func TestDegeneratePrefixesAreIgnored(t *testing.T) {
	withEnv(t, map[string]string{
		"USERPROFILE":  `C:\`,
		"LOCALAPPDATA": `D:\`,
		"APPDATA":      `X`,
		"USERNAME":     "Alice",
	})
	input := `C:\Windows\System32\cmd.exe and D:\Applications\CivicWorkDesk`
	if got := Paths(input); got != input {
		t.Errorf("a drive-root prefix was used as a substitution: %q", got)
	}
}

func TestEmptyEnvironmentIsSafe(t *testing.T) {
	for _, key := range prefixes {
		t.Setenv(key, "")
	}
	input := `C:\Users\Alice\AppData\Local\CivicWorkDesk`
	if got := Paths(input); got != input {
		t.Errorf("with no environment set, Paths must be a no-op; got %q", got)
	}
	if Paths("") != "" {
		t.Error("Paths(\"\") must be empty")
	}
}

func TestContainsUserName(t *testing.T) {
	t.Setenv("USERNAME", "Alice")
	if !ContainsUserName(`C:\Users\Alice\Desktop`) {
		t.Error("ContainsUserName missed the account name")
	}
	if !ContainsUserName(`c:\users\ALICE\desktop`) {
		t.Error("ContainsUserName is case sensitive")
	}
	if ContainsUserName(`D:\Applications\CivicWorkDesk`) {
		t.Error("ContainsUserName matched a path that does not contain the name")
	}
	// A two-character account name would match inside ordinary words, so it is not searched for. That
	// is a real limit of the check and is asserted so it stays deliberate.
	t.Setenv("USERNAME", "Al")
	if ContainsUserName(`C:\Users\Al\Desktop`) {
		t.Error("a name under three characters must not be searched for")
	}
}

// Redaction must survive the round trip through a real environment: this is the case the diagnostics
// tool actually runs in.
func TestAgainstTheRealEnvironment(t *testing.T) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		t.Skip("LOCALAPPDATA is not set in this environment")
	}
	sample := filepath.Join(local, "CivicWorkDesk", "logs", "server.log")
	got := Paths(sample)
	if !strings.HasPrefix(got, "%LOCALAPPDATA%") {
		t.Errorf("the real LOCALAPPDATA was not rewritten: %q", got)
	}
	if ContainsUserName(got) {
		t.Errorf("the account name survived redaction: %q", got)
	}
}
