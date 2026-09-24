// Command civic-diag writes one text file describing this installation, and opens it.
//
// It is what the Start Menu entry "收集诊断信息" runs, and it exists so an ordinary colleague never has
// to be talked through a terminal. When something fails, the whole support interaction is: run this,
// send back the txt.
//
// ## What it will not collect
//
// No work records. No IndexedDB contents. No browser history, cookies or passwords. No exported
// document contents. No file contents of any kind except the deployment's own log, which by construction
// holds only request lines -- method, path, status, bytes, duration -- and no user data.
//
// ## And what RC2 stopped collecting
//
// RC1 reported the machine name and the account name as fields of their own, and every path in it
// carried the account name a second time. None of that is needed to diagnose a deployment: the useful
// facts are which release is active, whether the port is free, and whether process ownership can be
// proven. So the two fields are gone and paths are rewritten to the environment variable they came
// from -- `%LOCALAPPDATA%\\CivicWorkDesk\\...` rather than `C:\\Users\\<someone>\\...`.
//
// A custom installation directory such as `D:\\Applications\\CivicWorkDesk` is deliberately left
// verbatim: it identifies nobody, and losing it would make exactly the installations this release added
// support for impossible to diagnose.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/redact"
	"civicworkdesk/windows/internal/release"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

const (
	canonicalOrigin   = "http://127.0.0.1:8765"
	canonicalHostPort = "127.0.0.1:8765"
	maxLogTail        = 200
)

func main() {
	var b strings.Builder
	// Every line goes through the redactor on the way out, so a path cannot reach the report by some
	// route the author forgot to wrap. That is the difference between "the fields I remembered are
	// clean" and "the file is clean".
	w := func(format string, args ...any) {
		fmt.Fprintf(&b, "%s\n", redact.Paths(fmt.Sprintf(format, args...)))
	}

	w("政务工作记录台 — 诊断信息 / CivicWorkDesk diagnostic report")
	w("")
	w("采集时间 : %s", time.Now().Format(time.RFC3339))
	w("固定访问地址 : %s/", canonicalOrigin)
	w("")
	w("这份文件包含：Windows 版本、已安装的程序版本、本地服务运行状态、端口状态、")
	w("默认浏览器标识，以及程序自身的运行日志。")
	w("%s", "用户目录已替换为环境变量形式（例如 %LOCALAPPDATA%），不含账号名与计算机名。")
	w("这份文件不包含：任何工作记录、任何浏览器数据（历史、Cookie、密码、站点存储内容）、")
	w("任何文档内容，也不含任何口令或密钥。")
	w("")

	section(w, "1. Windows")
	w("  OS                : %s", osDescription())
	w("  architecture      : %s", os.Getenv("PROCESSOR_ARCHITECTURE"))
	// The machine name and the account name were RC1 fields and are deliberately absent: neither is
	// needed to diagnose this deployment, and both identify the person forwarding the file.
	if progID, err := winproc.DefaultBrowserProgID(); err == nil {
		w("  default browser   : %s", progID)
	} else {
		w("  default browser   : (not recorded: %v)", err)
	}

	tree, err := layout.Default()
	if err != nil {
		section(w, "2. Installation")
		w("  ERROR: cannot locate the installation root: %v", err)
		finish(b.String())
		return
	}

	section(w, "2. Installation")
	w("  install root      : %s", tree.Root)
	w("  install root kind : %s", installRootKind(tree.Root))
	activeID, activeErr := tree.ActiveRelease()
	if activeErr != nil {
		w("  active release    : (none) %v", activeErr)
	} else {
		w("  active release    : %s", activeID)
	}
	if prev, err := tree.PreviousRelease(); err == nil {
		w("  rollback target   : %s", prev)
	} else {
		w("  rollback target   : (none)")
	}
	if ids, err := tree.InstalledReleases(); err == nil {
		w("  installed         : %s", strings.Join(ids, ", "))
	}
	for _, name := range []string{"civic-server.exe", "civic-launch.exe", "civic-diag.exe", "civic-admin.exe"} {
		p := filepath.Join(tree.Bin(), name)
		if info, err := os.Stat(p); err == nil {
			w("  bin\\%-18s %d bytes  %s", name, info.Size(), info.ModTime().Format(time.RFC3339))
		} else {
			w("  bin\\%-18s MISSING", name)
		}
	}

	section(w, "3. Release integrity")
	if activeErr == nil {
		if dir, err := tree.Release(activeID); err == nil {
			if err := tree.AssertReleaseShape(activeID); err != nil {
				w("  shape             : WRONG -- %v", err)
			} else {
				w("  shape             : correct")
			}
			if res, err := release.Verify(dir); err != nil {
				w("  payload           : cannot verify -- %v", err)
			} else {
				w("  payload           : %s", res.Summary())
			}
			if v, err := release.ReadVersion(dir); err == nil {
				for _, key := range v.Keys {
					w("  VERSION %-18s %s", key, v.Get(key))
				}
			}
		}
	} else {
		w("  (no active release to verify)")
	}

	section(w, "4. Server")
	occupied := serverstate.PortOccupied(canonicalHostPort)
	w("  port 8765         : %s", map[bool]string{true: "something is listening", false: "free"}[occupied])
	probe := serverstate.ProbeHealth(canonicalOrigin)
	switch {
	case !occupied:
		w("  health            : not running")
	case probe.Err != nil:
		w("  health            : the listener is not CivicWorkDesk -- %v", probe.Err)
	default:
		w("  health            : serving release %s", probe.Health.ReleaseID)
		w("  server pid        : %d", probe.Health.PID)
		w("  server exe        : %s", probe.Health.ExePath)
		w("  server version    : %s", probe.Health.ServerVersion)
		w("  started at        : %s", probe.Health.StartedAt)
		w("  serving from      : %s", probe.Health.AppDir)
		w("  install root      : %s", probe.Health.InstallRoot)
	}

	state, serr := serverstate.Read(tree.State())
	if serr != nil {
		w("  recorded process  : none (%v)", serr)
	} else {
		// The token is a capability. Report that one exists and nothing more.
		w("  recorded process  : pid %d  created %d", state.Identity.PID, state.Identity.CreationTime)
		w("  recorded exe      : %s", state.Identity.ExePath)
		w("  recorded release  : %s", state.Identity.ReleaseID)
		w("  shutdown token    : present (%d characters, not printed)", len(state.ShutdownToken))
		proven, why := winproc.VerifyOwned(state.Identity, tree.Root, activeID)
		if proven {
			w("  ownership         : PROVEN -- this installation may stop it")
			if exe, creation, err := winproc.Inspect(state.Identity.PID); err == nil {
				w("  live check        : exe=%s creation=%d", exe, creation)
			}
		} else {
			w("  ownership         : NOT PROVEN -- %s", why)
			w("                      (the program will refuse to terminate it; this is deliberate)")
		}
	}

	section(w, "5. Deployment log (last %d lines)", maxLogTail)
	logFile := filepath.Join(tree.Logs(), "server.log")
	if tail, err := tailFile(logFile, maxLogTail); err != nil {
		w("  cannot read %s: %v", logFile, err)
	} else if len(tail) == 0 {
		w("  %s is empty", logFile)
	} else {
		w("  file: %s", logFile)
		w("")
		for _, line := range tail {
			w("  %s", line)
		}
	}

	section(w, "6. 如何反馈")
	w("  请将这份诊断文件（TXT）原样反馈给维护人员。")
	w("  如果程序还能打开，也请访问一次 %s/__civic/platform ，", canonicalOrigin)
	w("  点“复制全部结果”，把那段文字一并反馈。")

	finish(b.String())
}

func section(w func(string, ...any), title string, args ...any) {
	w("")
	w("%s", strings.Repeat("=", 78))
	w(title, args...)
	w("%s", strings.Repeat("=", 78))
}

// finish writes the report where an ordinary user will find it, and opens it.
//
// The Desktop is chosen over the installation's own logs directory for exactly one reason: the person
// running this has been told "send back the txt", and they must be able to find it without being given a
// path. Falling back through TEMP means the tool still produces something on a machine with a redirected
// or read-only Desktop.
func finish(report string) {
	name := fmt.Sprintf("CivicWorkDesk-诊断信息-%s.txt", time.Now().Format("20060102-150405"))
	// UTF-8 with a BOM: this file is opened in Notepad on a Chinese-locale machine and must not be
	// guessed as the ANSI code page.
	body := append([]byte{0xEF, 0xBB, 0xBF}, []byte(strings.ReplaceAll(report, "\n", "\r\n"))...)

	var written string
	for _, dir := range candidateDirs() {
		if dir == "" {
			continue
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, body, 0o644); err == nil {
			written = path
			break
		}
	}
	if written == "" {
		fmt.Print(report)
		fmt.Fprintln(os.Stderr, "\n无法写出诊断文件，以上为完整内容，请复制后反馈。")
		os.Exit(5)
	}

	fmt.Printf("诊断文件已保存至：\n\n    %s\n\n请将该诊断文件（TXT）反馈给维护人员。\n", written)
	// Opening it is a convenience, not the deliverable. If the shell refuses, the path above is enough.
	_ = winproc.OpenInDefaultBrowserOrEditor(written)
}

func candidateDirs() []string {
	var dirs []string
	if profile := os.Getenv("USERPROFILE"); profile != "" {
		dirs = append(dirs, filepath.Join(profile, "Desktop"))
	}
	if tree, err := layout.Default(); err == nil {
		dirs = append(dirs, tree.Logs())
	}
	dirs = append(dirs, os.Getenv("TEMP"))
	return dirs
}

func osDescription() string {
	// Read from the registry rather than composing a name: the product name a user recognises is the one
	// Windows itself records.
	name := registryString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "ProductName")
	display := registryString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "DisplayVersion")
	build := registryString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "CurrentBuild")
	ubr := registryDword(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "UBR")
	if name == "" {
		return "(unknown)"
	}
	return fmt.Sprintf("%s  %s  build %s.%d", name, display, build, ubr)
}

func tailFile(path string, n int) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(strings.TrimRight(string(raw), "\r\n"), "\r\n", "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil, nil
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

// installRootKind says whether the installation is in the default place or somewhere the user chose.
//
// Redacting %LOCALAPPDATA% would otherwise make the two indistinguishable at a glance, and "is this a
// custom-path installation" is the first question to ask about a problem that only some people see.
func installRootKind(root string) string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return "unknown (LOCALAPPDATA is not set)"
	}
	if strings.EqualFold(filepath.Clean(root), filepath.Join(filepath.Clean(base), "CivicWorkDesk")) {
		return "default (%LOCALAPPDATA%\\CivicWorkDesk)"
	}
	return "custom installation directory"
}
