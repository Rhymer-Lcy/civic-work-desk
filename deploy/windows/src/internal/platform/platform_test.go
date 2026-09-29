package platform

import (
	"strings"
	"testing"
)

func TestClassifyAppliesThePolicyRowByRow(t *testing.T) {
	x64 := MachineAMD64
	ws := ProductWorkstation
	cases := []struct {
		name      string
		facts     Facts
		class     Class
		supported bool
		legacy    bool
	}{
		// The primary target.
		{"Windows 11 21H2", Facts{10, 0, 22000, ws, x64}, ClassWindows11, true, false},
		{"Windows 11 23H2", Facts{10, 0, 22631, ws, x64}, ClassWindows11, true, false},
		{"Windows 11 24H2", Facts{10, 0, 26100, ws, x64}, ClassWindows11, true, false},
		{"Windows 11 25H2 (the development machine)", Facts{10, 0, 26200, ws, x64}, ClassWindows11, true, false},
		// The legacy target: the colleague's machine is exactly this row.
		{"Windows 10 22H2", Facts{10, 0, 19045, ws, x64}, ClassWindows10_22H2, true, true},
		// Every other Windows 10.
		{"Windows 10 21H2 / LTSC 2021", Facts{10, 0, 19044, ws, x64}, ClassWindows10Other, false, false},
		{"Windows 10 2004", Facts{10, 0, 19041, ws, x64}, ClassWindows10Other, false, false},
		{"Windows 10 LTSC 2019", Facts{10, 0, 17763, ws, x64}, ClassWindows10Other, false, false},
		{"Windows 10 1507", Facts{10, 0, 10240, ws, x64}, ClassWindows10Other, false, false},
		// Builds between 22H2 and Windows 11 were Insider-only.
		{"Windows 10 Insider build", Facts{10, 0, 20000, ws, x64}, ClassUnrecognised, false, false},
		// Before Windows 10.
		{"Windows 8.1", Facts{6, 3, 9600, ws, x64}, ClassBeforeWindows, false, false},
		{"Windows 8", Facts{6, 2, 9200, ws, x64}, ClassBeforeWindows, false, false},
		{"Windows 7 SP1", Facts{6, 1, 7601, ws, x64}, ClassBeforeWindows, false, false},
		// Server shares build numbers with the desktop; only the product type tells them apart.
		{"Windows Server 2025", Facts{10, 0, 26100, ProductServer, x64}, ClassServer, false, false},
		{"Windows Server 2022", Facts{10, 0, 20348, ProductServer, x64}, ClassServer, false, false},
		{"Windows Server 2025 domain controller", Facts{10, 0, 26100, ProductDomainController, x64}, ClassServer, false, false},
		// Architecture refusals on an otherwise supported version.
		{"Windows 11 on ARM64", Facts{10, 0, 26100, ws, MachineARM64}, ClassWindows11, false, false},
		{"Windows 10 22H2 on ARM64", Facts{10, 0, 19045, ws, MachineARM64}, ClassWindows10_22H2, false, true},
		{"32-bit Windows 10 22H2", Facts{10, 0, 19045, ws, MachineI386}, ClassWindows10_22H2, false, true},
		{"architecture not determined", Facts{10, 0, 26100, ws, MachineUnknown}, ClassWindows11, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := Classify(c.facts)
			if v.Class != c.class {
				t.Errorf("class = %s, want %s", v.Class, c.class)
			}
			if v.Supported() != c.supported {
				t.Errorf("supported = %v, want %v (%+v)", v.Supported(), c.supported, v)
			}
			if v.Legacy != c.legacy {
				t.Errorf("legacy = %v, want %v", v.Legacy, c.legacy)
			}
			// A refusal must always say what WOULD be accepted, and an acceptance must say nothing.
			refusal := v.RefusalText()
			if c.supported && refusal != "" {
				t.Errorf("a supported machine produced a refusal: %q", refusal)
			}
			if !c.supported && !strings.HasSuffix(refusal, SupportedSystems) {
				t.Errorf("the refusal does not end by naming the supported systems: %q", refusal)
			}
		})
	}
}

// The two halves are reported separately, so a person on ARM64 Windows 11 is not told their Windows
// version is the problem.
func TestRefusalNamesOnlyTheFailingHalf(t *testing.T) {
	arm := Classify(Facts{10, 0, 26100, ProductWorkstation, MachineARM64})
	if !arm.OSSupported || arm.OSReason != "" {
		t.Errorf("Windows 11 on ARM64: the version half should pass, got %+v", arm)
	}
	if !strings.Contains(arm.ArchReason, "ARM64") {
		t.Errorf("ARM64 refusal does not name ARM64: %q", arm.ArchReason)
	}
	old := Classify(Facts{10, 0, 19044, ProductWorkstation, MachineAMD64})
	if !old.ArchSupported || old.ArchReason != "" {
		t.Errorf("Windows 10 21H2 x64: the architecture half should pass, got %+v", old)
	}
	if !strings.Contains(old.OSReason, "22H2") {
		t.Errorf("the old-Windows-10 refusal does not tell the person which version to move to: %q", old.OSReason)
	}
}

// End of support is information, not a gate.
func TestWindows10EndOfSupportDoesNotBlock(t *testing.T) {
	v := Classify(Facts{10, 0, Windows10_22H2Build, ProductWorkstation, MachineAMD64})
	if !v.Supported() || !v.Legacy {
		t.Fatalf("Windows 10 22H2 x64 must be supported and marked legacy, got %+v", v)
	}
	if !strings.Contains(EndOfSupportNotice, "2025 年 10 月 14 日") {
		t.Errorf("the notice lost its date: %q", EndOfSupportNotice)
	}
	if !strings.Contains(v.System, "22H2") {
		t.Errorf("the system name does not say 22H2: %q", v.System)
	}
}

// The boundary builds on each side of every threshold, so an off-by-one cannot hide.
func TestThresholdBoundaries(t *testing.T) {
	for build, want := range map[uint32]Class{
		19044: ClassWindows10Other,
		19045: ClassWindows10_22H2,
		19046: ClassUnrecognised,
		21999: ClassUnrecognised,
		22000: ClassWindows11,
	} {
		if got := Classify(Facts{10, 0, build, ProductWorkstation, MachineAMD64}).Class; got != want {
			t.Errorf("build %d: class %s, want %s", build, got, want)
		}
	}
}
