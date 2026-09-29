package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// policyFacts are the program-execution controls that can keep an unsigned per-user program from
// running. Read-only, from the registry, and only whether each is configured -- never the rule contents,
// which can name other software on the machine.
type policyFacts struct {
	srpKeyPresent        bool
	srpDefaultLevel      uint32
	srpDefaultLevelSet   bool
	srpRules             int
	appLockerRules       int
	appLockerCollections []string
	smartAppControl      string // "on", "evaluation", "off", "" when absent
	smartAppControlRaw   uint32
}

const (
	srpKey       = `SOFTWARE\Policies\Microsoft\Windows\Safer\CodeIdentifiers`
	appLockerKey = `SOFTWARE\Policies\Microsoft\Windows\SrpV2`
	sacKey       = `SYSTEM\CurrentControlSet\Control\CI\Policy`
)

// srpDisallowed is the Software Restriction Policies level that blocks everything not explicitly allowed.
const srpDisallowed = 0

func readPolicies() policyFacts {
	var p policyFacts

	// Software Restriction Policies. The key exists on many machines with nothing in it -- measured on the
	// development workstation, which carries only authenticodeenabled=0 -- so presence alone means
	// nothing. What blocks a program is a DefaultLevel of Disallowed, or rules under a level key.
	for _, root := range []syscall.Handle{syscall.HKEY_LOCAL_MACHINE, syscall.HKEY_CURRENT_USER} {
		key, ok := openKey(root, srpKey)
		if !ok {
			continue
		}
		p.srpKeyPresent = true
		if level, ok := queryDword(key, "DefaultLevel"); ok {
			p.srpDefaultLevel, p.srpDefaultLevelSet = level, true
		}
		for _, levelKey := range subkeys(key) {
			for _, kind := range []string{"Paths", "Hashes", "UrlZones"} {
				if k, ok := openKey(key, levelKey+`\`+kind); ok {
					p.srpRules += len(subkeys(k))
					_ = syscall.RegCloseKey(k)
				}
			}
		}
		_ = syscall.RegCloseKey(key)
	}

	// AppLocker: one subkey per rule collection, one subkey per rule inside it.
	if key, ok := openKey(syscall.HKEY_LOCAL_MACHINE, appLockerKey); ok {
		for _, collection := range subkeys(key) {
			if k, ok := openKey(key, collection); ok {
				n := len(subkeys(k))
				if n > 0 {
					p.appLockerRules += n
					p.appLockerCollections = append(p.appLockerCollections, fmt.Sprintf("%s:%d", collection, n))
				}
				_ = syscall.RegCloseKey(k)
			}
		}
		_ = syscall.RegCloseKey(key)
	}

	// Smart App Control (Windows 11 22H2 and later): 0 off, 1 on, 2 evaluation. Absent on Windows 10.
	if key, ok := openKey(syscall.HKEY_LOCAL_MACHINE, sacKey); ok {
		if v, ok := queryDword(key, "VerifiedAndReputablePolicyState"); ok {
			p.smartAppControlRaw = v
			p.smartAppControl = map[uint32]string{0: "off", 1: "on", 2: "evaluation"}[v]
			if p.smartAppControl == "" {
				p.smartAppControl = fmt.Sprintf("unknown (%d)", v)
			}
		}
		_ = syscall.RegCloseKey(key)
	}
	return p
}

// zoneIdentifier reports the Mark of the Web on a file: the ZoneId from its Zone.Identifier stream, or
// "" when it has none. Only the zone number is read; the stream can also carry the download URL, which is
// not needed and not reported.
func zoneIdentifier(path string) string {
	raw, err := os.ReadFile(path + ":Zone.Identifier")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ZoneId=") {
			return line
		}
	}
	return "present, no ZoneId"
}

func openKey(root syscall.Handle, path string) (syscall.Handle, bool) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, false
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(root, p, 0, syscall.KEY_READ, &key); err != nil {
		return 0, false
	}
	return key, true
}

func queryDword(key syscall.Handle, name string) (uint32, bool) {
	n, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, false
	}
	var valueType, value uint32
	size := uint32(unsafe.Sizeof(value))
	if err := syscall.RegQueryValueEx(key, n, nil, &valueType, (*byte)(unsafe.Pointer(&value)), &size); err != nil {
		return 0, false
	}
	return value, valueType == syscall.REG_DWORD
}

func subkeys(key syscall.Handle) []string {
	var names []string
	for i := uint32(0); ; i++ {
		buf := make([]uint16, 256)
		size := uint32(len(buf))
		if err := syscall.RegEnumKeyEx(key, i, &buf[0], &size, nil, nil, nil, nil); err != nil {
			return names
		}
		names = append(names, syscall.UTF16ToString(buf[:size]))
	}
}
