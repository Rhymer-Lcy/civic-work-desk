package main

import (
	"syscall"
	"unsafe"
)

// registryString reads one HKLM string value, or returns "".
//
// Read-only, and only from the two well-known Windows-version values the report quotes. There is no
// write path in this program at all.
func registryString(keyPath, valueName string) string {
	key, ok := openLocalMachine(keyPath)
	if !ok {
		return ""
	}
	defer func() { _ = syscall.RegCloseKey(key) }()

	name, err := syscall.UTF16PtrFromString(valueName)
	if err != nil {
		return ""
	}
	var valueType, size uint32
	if err := syscall.RegQueryValueEx(key, name, nil, &valueType, nil, &size); err != nil {
		return ""
	}
	buf := make([]uint16, size/2+1)
	if err := syscall.RegQueryValueEx(key, name, nil, &valueType,
		(*byte)(unsafe.Pointer(&buf[0])), &size); err != nil {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// registryDword reads one HKLM DWORD value, or returns 0.
func registryDword(keyPath, valueName string) uint32 {
	key, ok := openLocalMachine(keyPath)
	if !ok {
		return 0
	}
	defer func() { _ = syscall.RegCloseKey(key) }()

	name, err := syscall.UTF16PtrFromString(valueName)
	if err != nil {
		return 0
	}
	var valueType uint32
	var value uint32
	size := uint32(unsafe.Sizeof(value))
	if err := syscall.RegQueryValueEx(key, name, nil, &valueType,
		(*byte)(unsafe.Pointer(&value)), &size); err != nil {
		return 0
	}
	return value
}

func openLocalMachine(keyPath string) (syscall.Handle, bool) {
	p, err := syscall.UTF16PtrFromString(keyPath)
	if err != nil {
		return 0, false
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, p, 0, syscall.KEY_READ, &key); err != nil {
		return 0, false
	}
	return key, true
}
