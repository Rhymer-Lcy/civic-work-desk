package main

import (
	"strings"
	"testing"
)

func healthy() evidence {
	return evidence{platformSupported: true, activeRelease: true, integrityOK: true, lastLaunchOutcome: "ok"}
}

func categories(fs []finding) string {
	var c []string
	for _, f := range fs {
		c = append(c, f.category)
	}
	return strings.Join(c, ",")
}

// Each failure class the field kit must distinguish produces its own category, and a healthy machine
// produces exactly "none-detected".
func TestConclusionDistinguishesEachFailureClass(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*evidence)
		want   string
	}{
		{"healthy", func(e *evidence) {}, catNoneDetected},
		{"unsupported OS", func(e *evidence) { e.platformSupported, e.platformReason = false, "Windows 10 21H2" }, catUnsupportedOS},
		{"policy block at launch", func(e *evidence) { e.lastLaunchOutcome = "server-blocked-by-policy" }, catSecurityPolicy},
		{"policy configured", func(e *evidence) { e.appLockerRules = 3 }, catSecurityPolicy},
		{"SRP default disallowed", func(e *evidence) { e.srpDefaultDisallowed = true }, catSecurityPolicy},
		{"application control at launch", func(e *evidence) { e.lastLaunchOutcome = "server-blocked-by-application-control" }, catExecutableBlock},
		{"anti-malware at launch", func(e *evidence) { e.lastLaunchOutcome = "server-blocked-by-security-software" }, catExecutableBlock},
		{"quarantined binary", func(e *evidence) { e.missingBinaries = []string{"civic-server.exe"} }, catExecutableBlock},
		{"Smart App Control on", func(e *evidence) { e.smartAppControl = "on" }, catExecutableBlock},
		{"port conflict at launch", func(e *evidence) { e.lastLaunchOutcome = "port-conflict-foreign-program" }, catPortConflict},
		{"port held now", func(e *evidence) { e.portForeign = true }, catPortConflict},
		{"browser would not open", func(e *evidence) { e.lastLaunchOutcome = "browser-launch-failed" }, catBrowserLaunch},
		{"server did not answer", func(e *evidence) { e.lastLaunchOutcome = "server-not-responding" }, catServerFailure},
		{"integrity failure", func(e *evidence) { e.integrityOK = false }, catServerFailure},
		{"opened under localhost", func(e *evidence) { e.nonCanonicalHostRequests = 4 }, catOriginProfile},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := healthy()
			c.mutate(&e)
			if got := categories(conclude(e)); got != c.want {
				t.Fatalf("categories %q, want %q", got, c.want)
			}
		})
	}
}

// Two problems at once are both reported; neither hides the other.
func TestConclusionReportsEveryCategory(t *testing.T) {
	e := healthy()
	e.appLockerRules = 1
	e.portForeign = true
	got := categories(conclude(e))
	if got != catSecurityPolicy+","+catPortConflict {
		t.Fatalf("got %q", got)
	}
}

// Smart App Control in evaluation mode does not block, so it is not a finding.
func TestSmartAppControlEvaluationIsNotAFinding(t *testing.T) {
	e := healthy()
	e.smartAppControl = "evaluation"
	if got := categories(conclude(e)); got != catNoneDetected {
		t.Fatalf("got %q", got)
	}
}

func TestLastLaunchOutcomeReadsTheLastOpen(t *testing.T) {
	lines := []string{
		`2026-09-29T10:00:00+08:00 open outcome=port-conflict-foreign-program exit=3 release=x`,
		`2026-09-29T10:01:00+08:00 open outcome=ok exit=0 release=x`,
		`2026-09-29T10:02:00+08:00 stop outcome=stopped exit=0 release=x`,
	}
	if got := lastLaunchOutcome(lines); got != "ok" {
		t.Fatalf("got %q; a stop line must not be read as a launch", got)
	}
	if got := lastLaunchOutcome(nil); got != "" {
		t.Fatalf("got %q from no lines", got)
	}
}

func TestCountNonCanonicalHosts(t *testing.T) {
	lines := []string{
		"2026-09-29T10:00:00.000+08:00 req=1 GET / -> 200 10B 0.1ms",
		"2026-09-29T10:00:00.000+08:00 req=2 GET / -> 200 10B 0.1ms host=localhost:8765",
	}
	if got := countNonCanonicalHosts(lines); got != 1 {
		t.Fatalf("got %d", got)
	}
}
