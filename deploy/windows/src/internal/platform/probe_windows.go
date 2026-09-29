//go:build windows

package platform

import (
	"syscall"
	"unsafe"
)

var (
	ntdll                = syscall.NewLazyDLL("ntdll.dll")
	procRtlGetVersion    = ntdll.NewProc("RtlGetVersion")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procIsWow64Process2  = kernel32.NewProc("IsWow64Process2")
	procGetNativeSysInfo = kernel32.NewProc("GetNativeSystemInfo")
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

// Probe asks the operating system.
//
// RtlGetVersion rather than GetVersionEx, which since Windows 8.1 reports 6.2 to any program without a
// compatibility manifest and would make a Windows 11 machine look like Windows 8.
//
// IsWow64Process2 rather than PROCESSOR_ARCHITECTURE, which an x64 process running under emulation on
// ARM64 sees as "AMD64". The function exists from Windows 10 1511 onwards, so on every build this policy
// can accept it is present; where it is missing the machine is refused on its version anyway, and the
// architecture falls back to GetNativeSystemInfo only so the report can still name it.
func Probe() Facts {
	var f Facts
	info := osVersionInfoEx{}
	info.OSVersionInfoSize = uint32(unsafe.Sizeof(info))
	if r, _, _ := procRtlGetVersion.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		f.Major, f.Minor, f.Build = info.MajorVersion, info.MinorVersion, info.BuildNumber
		f.ProductType = info.ProductType
	}
	f.NativeMachine = nativeMachine()
	return f
}

func nativeMachine() uint16 {
	if procIsWow64Process2.Find() == nil {
		process, err := syscall.GetCurrentProcess()
		if err == nil {
			var processMachine, native uint16
			r, _, _ := procIsWow64Process2.Call(uintptr(process),
				uintptr(unsafe.Pointer(&processMachine)), uintptr(unsafe.Pointer(&native)))
			if r != 0 {
				return native
			}
		}
	}
	// SYSTEM_INFO begins with wProcessorArchitecture: 9 = AMD64, 12 = ARM64, 0 = x86.
	if procGetNativeSysInfo.Find() == nil {
		var sysInfo [48]byte
		procGetNativeSysInfo.Call(uintptr(unsafe.Pointer(&sysInfo[0])))
		switch uint16(sysInfo[0]) | uint16(sysInfo[1])<<8 {
		case 9:
			return MachineAMD64
		case 12:
			return MachineARM64
		case 0:
			return MachineI386
		}
	}
	return MachineUnknown
}
