//go:build windows

package winproc

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
)

// Dialog icons, as MessageBoxW names them.
const (
	DialogError       uint32 = 0x00000010 // MB_ICONERROR
	DialogInformation uint32 = 0x00000040 // MB_ICONINFORMATION
)

const (
	mbSetForeground = 0x00010000
	mbTopmost       = 0x00040000
)

// HasConsole reports whether this process can print somewhere a person or a caller will read.
//
// A GUI-subsystem program started from a shortcut has no standard handles at all: measured, every write
// to stdout fails with "The handle is invalid" and nothing appears. Started by a script with pipes -- the
// acceptance suite, the installer's own tooling -- it has them. So the question is asked of the handle
// itself rather than of how the program was built.
func HasConsole() bool {
	_, err := os.Stdout.Stat()
	return err == nil
}

// ShowDialog shows a modal message box and waits for it to be dismissed.
//
// Topmost and foreground, because the dialog most often reports why a browser window did NOT appear, and
// a dialog hidden behind whatever the user was looking at is indistinguishable from nothing happening.
func ShowDialog(title, text string, icon uint32) {
	t, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	m, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)),
		uintptr(icon|mbSetForeground|mbTopmost))
}
