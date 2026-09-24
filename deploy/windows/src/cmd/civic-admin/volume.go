//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	procGetDriveTypeW = kernel32.NewProc("GetDriveTypeW")
)

// Drive types as GetDriveTypeW reports them.
const (
	driveUnknown   = 0
	driveNoRootDir = 1
	driveRemovable = 2
	driveFixed     = 3
	driveRemote    = 4
	driveCDROM     = 5
	driveRAMDisk   = 6
)

// judgeVolume rejects volumes an offline-first installation must not live on.
//
// A removable drive can be unplugged while the local service is running from it; a network drive makes
// an explicitly offline product depend on a server; a CD-ROM is read-only. Each of those produces a
// failure long after installation, at a moment the user will not connect to this choice — so the
// refusal happens here, while there is still a dialog to explain it in.
//
// A RAM disk and an unknown type are allowed: both are unusual but neither is unsafe, and refusing
// something merely because it is unfamiliar would block a legitimate setup for no measured reason.
func judgeVolume(volume string) PathVerdict {
	root := volume + `\`
	ptr, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return rejected("无法识别驱动器 %s", volume)
	}
	kind, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(ptr)))
	switch kind {
	case driveRemovable:
		return rejected("不能安装到可移动驱动器 %s（设备拔出后程序将无法运行）", volume)
	case driveRemote:
		return rejected("不能安装到网络驱动器 %s（本程序按离线使用设计）", volume)
	case driveCDROM:
		return rejected("不能安装到只读光驱 %s", volume)
	case driveNoRootDir:
		return rejected("驱动器 %s 不存在", volume)
	case driveFixed, driveRAMDisk, driveUnknown:
		return PathVerdict{OK: true}
	default:
		return PathVerdict{OK: true}
	}
}
