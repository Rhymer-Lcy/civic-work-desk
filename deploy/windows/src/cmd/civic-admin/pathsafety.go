package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PathVerdict is the outcome of judging a proposed installation directory.
type PathVerdict struct {
	OK     bool
	Reason string
}

func rejected(format string, args ...any) PathVerdict {
	return PathVerdict{OK: false, Reason: fmt.Sprintf(format, args...)}
}

// protectedRoots are the places an installation must never be put, named by the environment variable
// Windows itself uses, so the check follows a relocated ProgramFiles or a non-C: system drive.
var protectedRoots = []string{
	"SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData",
	"CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
}

// JudgeInstallRoot decides whether a proposed installation directory is safe to use.
//
// ## Why each rule is here
//
// The default, %LOCALAPPDATA%\CivicWorkDesk, needs no administrator rights and is always writable.
// Allowing another directory means allowing a user to pick something the deployment cannot safely own,
// so each rejection below corresponds to a way that goes wrong rather than to a general tidiness rule:
//
//   - a relative path has no fixed meaning once the installer's working directory changes;
//   - a drive root would make the uninstaller's "remove the installation directory" step point at the
//     whole volume;
//   - Program Files, ProgramData and the Windows directory all need elevation, which this installer
//     does not have and must not ask for -- and a half-written installation there is worse than a
//     refusal;
//   - a UNC or network path makes an offline-first product depend on a server being reachable, and the
//     local service would be started from a path that can vanish mid-session;
//   - a removable or remote volume has the same problem with less warning;
//   - a component ending in a dot or a space is silently rewritten by Win32, so the directory the
//     deployment records and the directory Windows actually uses would differ.
//
// Spaces and non-ASCII characters are explicitly NOT rejected: `D:\政务工作记录台` is a perfectly
// reasonable choice, and every path in this deployment is passed as a single quoted argument or a Go
// string, never through a shell.
func JudgeInstallRoot(path string) PathVerdict {
	if strings.TrimSpace(path) == "" {
		return rejected("路径为空")
	}
	if strings.ContainsRune(path, 0) {
		return rejected("路径包含非法字符")
	}
	if strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//") {
		return rejected("不支持网络位置（UNC 路径）：%s", path)
	}
	if !filepath.IsAbs(path) {
		return rejected("不是绝对路径：%s", path)
	}

	clean := filepath.Clean(path)
	volume := filepath.VolumeName(clean)
	if volume == "" {
		return rejected("无法识别所在驱动器：%s", clean)
	}
	if strings.EqualFold(clean, volume+string(filepath.Separator)) || strings.EqualFold(clean, volume) {
		return rejected("不能直接安装到驱动器根目录：%s", clean)
	}

	// Every component must survive the Win32 name rules unchanged.
	for _, part := range strings.Split(strings.TrimPrefix(clean, volume), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return rejected("路径中的 %q 以点或空格结尾，Windows 会自动改写它", part)
		}
		if strings.ContainsAny(part, `<>:"|?*`) {
			return rejected("路径中的 %q 含有 Windows 不允许的字符", part)
		}
	}

	for _, key := range protectedRoots {
		root := os.Getenv(key)
		if root == "" {
			continue
		}
		if withinOrEqual(clean, root) {
			return rejected("不能安装到系统目录 %s（%s）", root, key)
		}
	}
	// %SystemDrive%\Users and the profile root itself are not installation directories either, though a
	// folder INSIDE the profile is fine -- that is where the default lives.
	if profile := os.Getenv("USERPROFILE"); profile != "" && strings.EqualFold(clean, filepath.Clean(profile)) {
		return rejected("不能直接安装到用户主目录：%s", clean)
	}

	if verdict := judgeVolume(volume); !verdict.OK {
		return verdict
	}

	// Writability last, because creating the directory is the only check with a side effect, and it
	// should not run for a path already rejected on its shape.
	if err := probeWritable(clean); err != nil {
		return rejected("当前用户无法在此位置写入：%s（%v）", clean, err)
	}
	return PathVerdict{OK: true, Reason: "可用"}
}

// withinOrEqual reports whether child is root or lies beneath it, comparing the way the filesystem
// does. The separator in the prefix matters: without it, `C:\Program Files Custom` would count as being
// inside `C:\Program Files`.
func withinOrEqual(child, root string) bool {
	c := strings.ToLower(filepath.Clean(child))
	r := strings.ToLower(filepath.Clean(root))
	if c == r {
		return true
	}
	return strings.HasPrefix(c, r+string(filepath.Separator))
}
