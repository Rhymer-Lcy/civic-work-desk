// Command civic-diag writes one text file describing this installation, and opens it.
//
// It is what the Start Menu entry "收集诊断信息" runs, and it exists so an ordinary colleague never has
// to be talked through a terminal. When something fails, the whole support interaction is: run this,
// send back the txt.
//
// ## What it will not collect
//
// No work records. No IndexedDB contents. No browser history, cookies or passwords. No exported
// document contents. No file contents of any kind except the deployment's own logs, which by
// construction hold only request lines (method, path, status, bytes, duration), launch outcomes and the
// installer's own transcript -- no user data.
//
// ## And what RC2 stopped collecting
//
// RC1 reported the machine name and the account name as fields of their own, and every path in it
// carried the account name a second time. None of that is needed to diagnose a deployment: the useful
// facts are which release is active, whether the port is free, and whether process ownership can be
// proven. So the two fields are gone and paths are rewritten to the environment variable they came
// from -- `%LOCALAPPDATA%\\CivicWorkDesk\\...` rather than `C:\\Users\\<someone>\\...`.
//
// A custom installation directory is reduced to its drive letter (D:\<CUSTOM_INSTALL_ROOT>), with the
// characteristics a path problem is diagnosed from reported separately.
//
// ## The conclusion comes first
//
// The report opens with a short conclusion that names which of the failure classes the evidence points
// to -- unsupported system, security policy, blocked executable, port conflict, browser launch, local
// service failure, or an origin/profile mix-up -- because the person reading it first is a maintainer
// deciding what to ask next. Every input to the conclusion is printed in full further down.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"civicworkdesk/windows/internal/launchlog"
	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/platform"
	"civicworkdesk/windows/internal/redact"
	"civicworkdesk/windows/internal/release"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

const (
	canonicalOrigin   = "http://127.0.0.1:8765"
	canonicalHostPort = "127.0.0.1:8765"
	maxLogTail        = 200
	maxLaunchTail     = 50
	maxInstallTail    = 80
)

var binaryNames = []string{"civic-server.exe", "civic-launch.exe", "civic-diag.exe", "civic-admin.exe"}

func main() {
	var head, body strings.Builder
	// Every line goes through the redactor on the way out, so a path cannot reach the report by some
	// route the author forgot to wrap. That is the difference between "the fields I remembered are
	// clean" and "the file is clean".
	writer := func(b *strings.Builder) func(string, ...any) {
		return func(format string, args ...any) {
			fmt.Fprintf(b, "%s\n", redact.Paths(fmt.Sprintf(format, args...)))
		}
	}
	h, w := writer(&head), writer(&body)
	var ev evidence

	h("政务工作记录台 — 诊断信息 / CivicWorkDesk diagnostic report")
	h("")
	h("采集时间 : %s", time.Now().Format(time.RFC3339))
	h("固定访问地址 : %s/", canonicalOrigin)
	h("")
	h("这份文件包含：Windows 版本、程序运行限制策略是否配置、已安装的程序版本、本地服务运行状态、")
	h("端口状态、默认浏览器标识，以及程序自身的运行日志。")
	h("%s", "用户目录已替换为环境变量形式（例如 %LOCALAPPDATA%）；自定义安装目录只保留盘符，")
	h("%s", "显示为 D:\\<CUSTOM_INSTALL_ROOT>。本文件不含账号名、计算机名，也不含你选择的目录名。")
	h("这份文件不包含：任何工作记录、任何浏览器数据（历史、Cookie、密码、站点存储内容）、")
	h("任何文档内容，也不含任何口令或密钥。")

	section(w, "1. Windows")
	facts := platform.Probe()
	verdict := platform.Classify(facts)
	ev.platformSupported = verdict.Supported()
	ev.platformReason = strings.ReplaceAll(verdict.RefusalText(), "\n", " ")
	w("  support class     : %s", verdict.Class)
	w("  system            : %s", verdict.System)
	w("  version           : %d.%d build %d, product type %d", facts.Major, facts.Minor, facts.Build, facts.ProductType)
	w("  native arch       : %s (IsWow64Process2)", verdict.Arch)
	if verdict.Supported() {
		w("  supported         : YES%s", map[bool]string{true: " (legacy target)", false: ""}[verdict.Legacy])
	} else {
		w("  supported         : NO -- %s", ev.platformReason)
	}
	if verdict.Legacy {
		w("  end of support    : %s", platform.EndOfSupportNotice)
	}
	// Windows 11 still records "Windows 10" as ProductName, so this line is quoted as the registry has it
	// and labelled as such. RC1-RC3 printed it as the OS name, which made a Windows 11 machine read as
	// Windows 10 -- measured on the development workstation (build 26200).
	w("  registry name     : %s  (Windows 11 still reports \"Windows 10\" here; the build decides)", osDescription())
	w("  PROCESSOR_ARCH.   : %s", os.Getenv("PROCESSOR_ARCHITECTURE"))
	// The machine name and the account name were RC1 fields and are deliberately absent: neither is
	// needed to diagnose this deployment, and both identify the person forwarding the file.
	if progID, err := winproc.DefaultBrowserProgID(); err == nil {
		w("  default browser   : %s", progID)
	} else {
		w("  default browser   : (not recorded: %v)", err)
	}

	pol := readPolicies()
	ev.srpDefaultDisallowed = pol.srpDefaultLevelSet && pol.srpDefaultLevel == srpDisallowed
	ev.srpRules, ev.appLockerRules, ev.smartAppControl = pol.srpRules, pol.appLockerRules, pol.smartAppControl
	w("  SRP policy key    : %s", yesNo(pol.srpKeyPresent))
	if pol.srpDefaultLevelSet {
		w("  SRP default level : 0x%X%s", pol.srpDefaultLevel,
			map[bool]string{true: " (Disallowed: only listed programs may run)", false: ""}[ev.srpDefaultDisallowed])
	} else {
		w("  SRP default level : not set")
	}
	w("  SRP rules         : %d", pol.srpRules)
	if pol.appLockerRules > 0 {
		w("  AppLocker rules   : %d (%s)", pol.appLockerRules, strings.Join(pol.appLockerCollections, ", "))
	} else {
		w("  AppLocker rules   : 0")
	}
	if pol.smartAppControl == "" {
		w("  Smart App Control : not present on this system")
	} else {
		w("  Smart App Control : %s", pol.smartAppControl)
	}

	tree, err := layout.Default()
	if err != nil {
		section(w, "2. Installation")
		w("  ERROR: cannot locate the installation root: %v", err)
		ev.activeRelease = false
		finish(head.String() + conclusionText(ev) + body.String())
		return
	}

	// Register the root BEFORE any line is written. From here on the writer's redaction covers it
	// everywhere it appears -- the server executable, the document root, the log file, an error string --
	// rather than only in the field below.
	redact.MaskInstallRoot(tree.Root)

	section(w, "2. Installation")
	w("  install root      : %s", tree.Root)
	w("  install root kind : %s", redact.RootKind(tree.Root))
	if redact.RootKind(tree.Root) == "custom" {
		// The directory names are withheld, so report what a custom-path problem is actually diagnosed
		// from. None of these can name a person.
		c := redact.Describe(tree.Root)
		w("  install volume    : %s", c.Volume)
		w("  path has spaces   : %s", yesNo(c.HasSpaces))
		w("  path has non-ASCII: %s", yesNo(c.HasNonASCII))
		w("  path depth        : %d", c.Depth)
		w("  path length       : %d", c.Length)
		w("  path writable     : %s", yesNo(rootWritable(tree.Root)))
	}
	activeID, activeErr := tree.ActiveRelease()
	var activeGen release.Generation
	activeGenKnown := false
	if activeErr != nil {
		w("  active release    : (none) %v", activeErr)
	} else {
		ev.activeRelease = true
		w("  active release    : %s", activeID)
		if dir, err := tree.Release(activeID); err == nil {
			if v, err := release.ReadVersion(dir); err == nil && v.Get("displayVersion") != "" {
				w("  display version   : %s", v.Get("displayVersion"))
			}
			if g, err := release.DataGeneration(dir); err == nil {
				activeGen, activeGenKnown = g, true
				w("  data format       : %s", g)
			} else {
				w("  data format       : cannot be established -- %v", err)
			}
		}
	}
	if prev, err := tree.PreviousRelease(); err == nil {
		w("  previous release  : %s", prev)
		w("  rollback          : %s", rollbackVerdict(tree, prev, activeGen, activeGenKnown))
	} else {
		w("  previous release  : (none)")
	}
	if ids, err := tree.InstalledReleases(); err == nil {
		w("  installed         : %s", strings.Join(ids, ", "))
	}
	for _, name := range binaryNames {
		p := filepath.Join(tree.Bin(), name)
		if info, err := os.Stat(p); err == nil {
			motw := zoneIdentifier(p)
			if motw == "" {
				motw = "no Mark of the Web"
			}
			w("  bin\\%-18s %d bytes  %s  %s", name, info.Size(), info.ModTime().Format(time.RFC3339), motw)
		} else {
			ev.missingBinaries = append(ev.missingBinaries, name)
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
				ev.integrityOK = res.OK()
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
		ev.portForeign = true
		w("  health            : the listener is not CivicWorkDesk -- %v", probe.Err)
	default:
		if !strings.EqualFold(filepath.Clean(probe.Health.InstallRoot), filepath.Clean(tree.Root)) {
			ev.portOtherInstall = true
		}
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

	section(w, "5. Launch log (last %d lines)", maxLaunchTail)
	launchFile := filepath.Join(tree.Logs(), launchlog.FileName)
	if all, err := readLines(launchFile); err != nil {
		w("  no launch has been recorded yet (%v)", err)
	} else {
		ev.lastLaunchOutcome = lastLaunchOutcome(all)
		w("  last launch       : %s", orText(ev.lastLaunchOutcome, "(none recorded)"))
		w("")
		for _, line := range tail(all, maxLaunchTail) {
			w("  %s", line)
		}
	}

	section(w, "6. Server log (last %d lines)", maxLogTail)
	logFile := filepath.Join(tree.Logs(), "server.log")
	if all, err := readLines(logFile); err != nil {
		w("  cannot read %s: %v", logFile, err)
	} else if len(all) == 0 {
		w("  %s is empty", logFile)
	} else {
		ev.nonCanonicalHostRequests = countNonCanonicalHosts(all)
		w("  file: %s", logFile)
		w("  requests under a non-canonical host (whole file): %d", ev.nonCanonicalHostRequests)
		w("")
		for _, line := range tail(all, maxLogTail) {
			w("  %s", line)
		}
	}

	section(w, "7. Installer transcript (last %d lines)", maxInstallTail)
	installFile := filepath.Join(tree.Logs(), "install.log")
	if all, err := readLines(installFile); err != nil {
		w("  cannot read %s: %v", installFile, err)
	} else {
		for _, line := range tail(all, maxInstallTail) {
			w("  %s", line)
		}
	}

	section(w, "8. 如何反馈")
	w("  请将这份诊断文件（TXT）原样反馈给维护人员。")
	w("  如果程序还能打开，也请访问一次 %s/api/civic/platform ，", canonicalOrigin)
	w("  点“复制全部结果”，把那段文字一并反馈。")
	w("  请不要为了让程序运行而关闭 Windows 安全中心、SmartScreen 或其他安全软件。")

	finish(head.String() + conclusionText(ev) + body.String())
}

// conclusionText renders the conclusion section. It is built after every other section, because it is
// drawn from what they found, and placed first, because it is what a maintainer reads first.
func conclusionText(ev evidence) string {
	var b strings.Builder
	w := func(format string, args ...any) {
		fmt.Fprintf(&b, "%s\n", redact.Paths(fmt.Sprintf(format, args...)))
	}
	section(w, "0. 诊断结论 / Conclusion")
	for _, f := range conclude(ev) {
		w("  [%s] %s", f.category, f.text)
	}
	return b.String()
}

// rollbackVerdict says whether going back to the previous release is safe, in the same terms civic-admin
// uses when it refuses.
func rollbackVerdict(tree layout.Tree, prev string, active release.Generation, activeKnown bool) string {
	dir, err := tree.Release(prev)
	if err != nil {
		return "NOT a safe rollback target -- " + err.Error()
	}
	target, err := release.DataGeneration(dir)
	if err != nil {
		return "NOT a safe rollback target -- its data format cannot be established: " + err.Error()
	}
	if !activeKnown {
		return "NOT a safe rollback target -- the active release's data format cannot be established"
	}
	if release.CheckTransition(active, target) != nil {
		return fmt.Sprintf("NOT a safe rollback target -- it uses %s, older than the active %s; "+
			"civic-admin refuses this rollback", target, active)
	}
	return fmt.Sprintf("allowed (%s)", target)
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
	// Read from the registry rather than composing a name. It is quoted, not trusted: see the caller.
	name := registryString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "ProductName")
	display := registryString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "DisplayVersion")
	build := registryString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "CurrentBuild")
	ubr := registryDword(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "UBR")
	if name == "" {
		return "(unknown)"
	}
	return fmt.Sprintf("%s  %s  build %s.%d", name, display, build, ubr)
}

func readLines(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	text := strings.TrimRight(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	if text == "" {
		return nil, nil
	}
	return strings.Split(text, "\n"), nil
}

func tail(lines []string, n int) []string {
	if len(lines) > n {
		return lines[len(lines)-n:]
	}
	return lines
}

func orText(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// yesNo renders a boolean the way a report reads best.
func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

// rootWritable answers the one characteristic that needs the filesystem rather than the string.
func rootWritable(root string) bool {
	probe := filepath.Join(root, ".civic-diag-write-probe.tmp")
	if err := os.WriteFile(probe, []byte("probe"), 0o644); err != nil {
		return false
	}
	_ = os.Remove(probe)
	return true
}
