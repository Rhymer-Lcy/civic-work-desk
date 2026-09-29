//go:build windows

package platform

import "testing"

// The probe runs on whatever machine executes the tests, so it can only assert what is true of every
// machine able to run them: the version was read, and the architecture was determined. The policy
// itself is tested against constructed facts in platform_test.go.
func TestProbeReadsTheRunningSystem(t *testing.T) {
	f := Probe()
	if f.Major < 10 || f.Build == 0 {
		t.Fatalf("RtlGetVersion was not read: %+v", f)
	}
	if f.ProductType == 0 {
		t.Errorf("the product type was not read: %+v", f)
	}
	if f.NativeMachine == MachineUnknown {
		t.Errorf("the native architecture was not determined: %+v", f)
	}
	t.Logf("this machine: %+v -> %+v", f, Classify(f))
}
