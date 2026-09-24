//go:build windows

package winproc

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	shell32           = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteW = shell32.NewProc("ShellExecuteW")
)

// OpenInDefaultBrowser hands a URL to the Windows shell.
//
// ## Why ShellExecuteW and not a browser path
//
// The shell resolves the user's own configured default handler for http. Whatever they chose -- Edge,
// Chrome, 360, Firefox, something a site administrator set -- is what opens, and the deployment never
// has to know the list. Hard-coding a browser is the mistake this avoids: on a managed government
// desktop the installed browser set is not ours to predict, and a hard-coded path fails silently on
// the machine that has something else.
//
// `cmd /c start` would also work and is what shell scripts reach for, but it flashes a console window
// and its quoting rules mangle a URL containing an ampersand. ShellExecuteW takes the URL as one
// argument and cannot be confused by its contents.
func OpenInDefaultBrowser(url string) error {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	target, err := syscall.UTF16PtrFromString(url)
	if err != nil {
		return fmt.Errorf("cannot encode url %q: %w", url, err)
	}
	// SW_SHOWNORMAL = 1. The return value is a pseudo HINSTANCE: anything above 32 is success, and
	// values at or below 32 are error codes. This is the documented, if unusual, contract.
	r, _, callErr := procShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(target)),
		0, 0, 1)
	if r <= 32 {
		return fmt.Errorf("ShellExecuteW could not open %q (code %d): %w", url, r, callErr)
	}
	return nil
}

// OpenInDefaultBrowserOrEditor opens a local file with whatever program the shell associates with it.
//
// Separate from OpenInDefaultBrowser because the intent is different: this is for showing a user the
// diagnostic report that was just written for them, and it must never be treated as a failure worth
// reporting -- the path was already printed, so the file is findable either way.
func OpenInDefaultBrowserOrEditor(path string) error {
	return OpenInDefaultBrowser(path)
}

// DefaultBrowserProgID reads the user's own choice of http handler.
//
// This is a read of one registry value under HKCU that Windows itself writes when the user picks a
// default browser. It is reported in diagnostics because "which browser was this measured in" is the
// first question about any browser-platform result. Nothing else about the browser is read -- no
// profile, no history, no storage.
func DefaultBrowserProgID() (string, error) {
	const keyPath = `SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice`
	name, err := syscall.UTF16PtrFromString(keyPath)
	if err != nil {
		return "", err
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, name, 0, syscall.KEY_READ, &key); err != nil {
		return "", fmt.Errorf("cannot open %s: %w", keyPath, err)
	}
	defer func() { _ = syscall.RegCloseKey(key) }()

	valueName, err := syscall.UTF16PtrFromString("ProgId")
	if err != nil {
		return "", err
	}
	var valueType uint32
	var size uint32
	if err := syscall.RegQueryValueEx(key, valueName, nil, &valueType, nil, &size); err != nil {
		return "", fmt.Errorf("cannot size ProgId: %w", err)
	}
	buf := make([]uint16, size/2+1)
	if err := syscall.RegQueryValueEx(key, valueName, nil, &valueType,
		(*byte)(unsafe.Pointer(&buf[0])), &size); err != nil {
		return "", fmt.Errorf("cannot read ProgId: %w", err)
	}
	return syscall.UTF16ToString(buf), nil
}
