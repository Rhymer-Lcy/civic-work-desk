// Package platform decides whether this computer is one the Windows build supports, and says why.
//
// ## The support policy, in one place
//
// Supported:
//
//   - Windows 11 x64 (build 22000 or later, workstation edition) -- the primary target.
//   - Windows 10 22H2 x64 (build 19045, workstation edition) -- a legacy target, subject to real-machine
//     validation. Windows 10 reached the end of support on 2025-10-14, so a machine in this class is told
//     so, and is not refused for it.
//
// Refused, each with its own reason:
//
//   - Windows 7, 8 and 8.1 (major version below 10);
//   - any Windows 10 version other than 22H2, including LTSC 2021 (build 19044) and LTSC 2019 (17763);
//   - Windows Server, whatever its build. Server 2025 is build 26100 -- the same number as a Windows 11
//     release -- so a build-number check alone would call it Windows 11. The product type is what
//     separates the two;
//   - x86 and ARM64 hardware. An ARM64 machine runs x64 programs under emulation and reports "AMD64" to
//     them through PROCESSOR_ARCHITECTURE, which is exactly why that variable cannot answer the question
//     and IsWow64Process2 is asked instead.
//
// The decision is a pure function of Facts, so every row of the policy is tested without the machine
// that the row describes.
package platform

import "fmt"

// Machine types, as IsWow64Process2 reports them (IMAGE_FILE_MACHINE_*).
const (
	MachineUnknown uint16 = 0
	MachineI386    uint16 = 0x014c
	MachineAMD64   uint16 = 0x8664
	MachineARM64   uint16 = 0xAA64
)

// Product types, as RtlGetVersion reports them (VER_NT_*).
const (
	ProductWorkstation      byte = 1
	ProductDomainController byte = 2
	ProductServer           byte = 3
)

// Build numbers the policy names.
const (
	// Windows11FirstBuild is the first Windows 11 release (21H2).
	Windows11FirstBuild uint32 = 22000
	// Windows10_22H2Build is the only Windows 10 build this program supports.
	Windows10_22H2Build uint32 = 19045
)

// Facts are what the operating system reports about itself. Probe fills them on Windows; tests
// construct them directly.
type Facts struct {
	Major, Minor, Build uint32
	ProductType         byte
	NativeMachine       uint16
}

// Class names what the machine is, as far as this policy is concerned.
type Class string

const (
	ClassWindows11      Class = "windows-11"
	ClassWindows10_22H2 Class = "windows-10-22h2"
	ClassWindows10Other Class = "windows-10-other"
	ClassBeforeWindows  Class = "before-windows-10"
	ClassServer         Class = "windows-server"
	ClassUnrecognised   Class = "unrecognised"
)

// Verdict is the decision and everything needed to explain it.
type Verdict struct {
	Class Class
	// System is the name to show a person, in Chinese.
	System string
	// Arch is the native processor architecture: x64, ARM64, x86, or unknown.
	Arch string

	OSSupported   bool
	ArchSupported bool
	// Legacy is true for the Windows 10 22H2 class: supported, but past the end of support.
	Legacy bool

	// OSReason and ArchReason explain a refusal, in Chinese. Empty when that half passes.
	OSReason   string
	ArchReason string
}

// Supported reports whether both halves pass.
func (v Verdict) Supported() bool { return v.OSSupported && v.ArchSupported }

// SupportedSystems is the one sentence every refusal ends with, so a person told "no" is also told
// what would be "yes".
const SupportedSystems = "支持的系统：Windows 11 x64，或 Windows 10 22H2（内部版本 19045）x64。"

// EndOfSupportNotice is shown on the Windows 10 22H2 class. It informs; it does not block.
const EndOfSupportNotice = "Windows 10 已于 2025 年 10 月 14 日结束支持。本程序可以在 Windows 10 22H2 上安装和使用，" +
	"但建议尽早升级到 Windows 11。"

// Classify applies the support policy to what the operating system reported.
func Classify(f Facts) Verdict {
	v := Verdict{Arch: archName(f.NativeMachine)}

	switch f.NativeMachine {
	case MachineAMD64:
		v.ArchSupported = true
	case MachineARM64:
		v.ArchReason = "这台计算机使用 ARM64 处理器。本程序只支持 x64（Intel 或 AMD 64 位）处理器，" +
			"不支持在 ARM64 设备上通过 x64 仿真运行。"
	case MachineI386:
		v.ArchReason = "这台计算机运行的是 32 位（x86）Windows。本程序只支持 64 位（x64）Windows。"
	default:
		v.ArchReason = fmt.Sprintf("无法确认这台计算机的处理器架构（机器类型 0x%04X）。本程序只支持 x64 Windows。",
			f.NativeMachine)
	}

	switch {
	case f.Major < 10:
		v.Class, v.System = ClassBeforeWindows, fmt.Sprintf("Windows %d.%d（早于 Windows 10）", f.Major, f.Minor)
		v.OSReason = "Windows 7、Windows 8 和 Windows 8.1 不在支持范围内。"
	case f.ProductType != ProductWorkstation:
		v.Class, v.System = ClassServer, fmt.Sprintf("Windows Server（内部版本 %d）", f.Build)
		v.OSReason = "Windows Server 不在支持范围内；本程序只支持桌面版 Windows。"
	case f.Major == 10 && f.Build >= Windows11FirstBuild:
		v.Class, v.System = ClassWindows11, fmt.Sprintf("Windows 11（内部版本 %d）", f.Build)
		v.OSSupported = true
	case f.Major == 10 && f.Build == Windows10_22H2Build:
		v.Class, v.System = ClassWindows10_22H2, fmt.Sprintf("Windows 10 22H2（内部版本 %d）", f.Build)
		v.OSSupported, v.Legacy = true, true
	case f.Major == 10 && f.Build < Windows10_22H2Build:
		v.Class, v.System = ClassWindows10Other, fmt.Sprintf("Windows 10（内部版本 %d，早于 22H2）", f.Build)
		v.OSReason = "这个 Windows 10 版本不在支持范围内；Windows 10 只支持 22H2（内部版本 19045）。" +
			"请通过 Windows 更新升级到 22H2，或改用 Windows 11。"
	default:
		v.Class, v.System = ClassUnrecognised, fmt.Sprintf("无法识别的 Windows 版本（%d.%d，内部版本 %d）",
			f.Major, f.Minor, f.Build)
		v.OSReason = "无法识别这个 Windows 版本，不能确认它在支持范围内。"
	}
	return v
}

// RefusalText is the whole explanation for an unsupported machine, or "" for a supported one.
func (v Verdict) RefusalText() string {
	if v.Supported() {
		return ""
	}
	text := ""
	if v.OSReason != "" {
		text += v.OSReason + "\n"
	}
	if v.ArchReason != "" {
		text += v.ArchReason + "\n"
	}
	return text + SupportedSystems
}

func archName(machine uint16) string {
	switch machine {
	case MachineAMD64:
		return "x64"
	case MachineARM64:
		return "ARM64"
	case MachineI386:
		return "x86"
	default:
		return fmt.Sprintf("unknown (0x%04X)", machine)
	}
}
