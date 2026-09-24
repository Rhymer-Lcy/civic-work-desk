// Command civic-launch is what the Start Menu shortcut runs.
//
//	civic-launch.exe            start if needed, then open the browser
//	civic-launch.exe status     report what is running, and exit
//	civic-launch.exe stop       stop the server this installation started
//	civic-launch.exe platform   open the browser-platform check page
//
// ## Repeated double-clicks are safe
//
// A user who clicks twice, or who clicks again because the browser was slow, must not get a second
// server, a port conflict, or an error. The launch path takes a lock, reuses a healthy server it can
// prove it owns, and only starts one when there is none -- so the second click opens a browser tab and
// does nothing else.
//
// ## Messages are in Chinese
//
// Everything a user can see here is user-facing text on a colleague's machine. Engineering detail goes
// to the log and to the diagnostic report, not to the dialog.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"civicworkdesk/windows/internal/httpserve"
	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

const (
	canonicalOrigin   = "http://127.0.0.1:8765"
	canonicalHostPort = "127.0.0.1:8765"
	healthTimeout     = 20 * time.Second
	lockFileName      = "launch.lock"
	serverExeName     = "civic-server.exe"
)

const (
	exitOK       = 0
	exitUsage    = 2
	exitPortBusy = 3
	exitRelease  = 4
	exitInternal = 5
	exitBusy     = 6
)

func main() {
	args := os.Args[1:]
	command := "open"
	if len(args) > 0 {
		command = args[0]
	}
	switch command {
	case "open":
		os.Exit(cmdOpen())
	case "status":
		os.Exit(cmdStatus())
	case "stop":
		os.Exit(cmdStop())
	case "platform":
		os.Exit(cmdPlatform())
	case "-h", "--help", "help":
		fmt.Println("用法: civic-launch.exe [open|status|stop|platform]")
		os.Exit(exitOK)
	default:
		fmt.Fprintf(os.Stderr, "未知的子命令: %s\n用法: civic-launch.exe [open|status|stop|platform]\n", command)
		os.Exit(exitUsage)
	}
}

// fail prints a Chinese explanation for the user and a technical line for the record.
func fail(userText string, detail error) {
	fmt.Fprintln(os.Stderr, userText)
	if detail != nil {
		fmt.Fprintf(os.Stderr, "\n技术细节: %v\n", detail)
	}
	fmt.Fprintln(os.Stderr, "\n如果反复出现，请从开始菜单运行“收集诊断信息”，把生成的 txt 发回。")
}

func resolve() (layout.Tree, string, error) {
	tree, err := layout.Default()
	if err != nil {
		return layout.Tree{}, "", err
	}
	id, err := tree.ActiveRelease()
	if err != nil {
		return tree, "", err
	}
	return tree, id, nil
}

func cmdOpen() int {
	tree, releaseID, err := resolve()
	if err != nil {
		if errors.Is(err, layout.ErrNoActiveRelease) {
			fail("没有找到已安装的版本。请重新运行安装包。", err)
			return exitRelease
		}
		fail("无法定位安装目录。", err)
		return exitRelease
	}

	// One lock for the whole decide-and-start sequence. Without it, two clicks a few milliseconds apart
	// both see "nothing is running" and both try to bind the port; one of them then fails with a port
	// conflict that looks to the user like another program is in the way.
	lock, err := winproc.AcquireLock(filepath.Join(tree.State(), lockFileName))
	if err != nil {
		if errors.Is(err, winproc.ErrLockBusy) {
			// Another click is already starting the server. Waiting for it and opening the browser is
			// the behaviour a user expects from a second double-click.
			if h, werr := serverstate.WaitUntilHealthy(canonicalOrigin, tree.Root, releaseID, healthTimeout); werr == nil {
				return openBrowser(canonicalOrigin, h.ReleaseID)
			}
			fail("程序正在启动中，请稍等几秒后再点一次。", err)
			return exitBusy
		}
		fail("无法获取启动锁。", err)
		return exitInternal
	}
	defer lock.Release()

	// 1. Is a server we own already healthy? Reuse it.
	if h, ok := ownedHealthyServer(tree, releaseID); ok {
		return openBrowser(canonicalOrigin, h.ReleaseID)
	}

	// 2. Is something else on the port? Say so precisely, and do not touch it.
	if serverstate.PortOccupied(canonicalHostPort) {
		probe := serverstate.ProbeHealth(canonicalOrigin)
		switch {
		case probe.Err == nil && probe.Health.Application == "civic-work-desk":
			fail(fmt.Sprintf(
				"端口 %s 上已经有另一个 CivicWorkDesk 在运行，但它不属于当前这个安装。\n"+
					"（它的安装目录是 %s，发布版本 %s。）\n"+
					"请先关闭那一个，或直接使用它。",
				canonicalHostPort, probe.Health.InstallRoot, probe.Health.ReleaseID), nil)
		default:
			fail(fmt.Sprintf(
				"端口 %s 已被其他程序占用，政务工作记录台无法启动。\n\n"+
					"程序不会去结束占用它的进程，也不会改用其他端口：\n"+
					"应用的数据是绑定在这个地址上的，换端口等于打开一个空白的新应用。\n\n"+
					"请关闭占用该端口的程序后重试。", canonicalHostPort), probe.Err)
		}
		return exitPortBusy
	}

	// 3. Nothing is there. Start our own.
	if err := startServer(tree, releaseID); err != nil {
		fail("启动本地服务失败。", err)
		return exitInternal
	}

	// 4. Wait for the health gate, and require the exact release.
	h, err := serverstate.WaitUntilHealthy(canonicalOrigin, tree.Root, releaseID, healthTimeout)
	if err != nil {
		fail("本地服务已启动，但没有在预期时间内正常响应。", err)
		return exitInternal
	}
	return openBrowser(canonicalOrigin, h.ReleaseID)
}

// ownedHealthyServer returns the health of a running server this installation started, if there is
// one that can be proven to be ours.
//
// Both halves matter. The health endpoint proves what is being served; the process identity proves the
// thing serving it is a process we started from this installation. Accepting either on its own would
// mean reusing a stranger's server, or trusting a state file whose PID has been recycled.
func ownedHealthyServer(tree layout.Tree, releaseID string) (health httpserve.Health, ok bool) {
	state, err := serverstate.Read(tree.State())
	if err != nil {
		return health, false
	}
	if proven, _ := winproc.VerifyOwned(state.Identity, tree.Root, releaseID); !proven {
		// The record is stale: the process is gone, or its PID now belongs to something else. Clear it
		// so the next run does not re-examine the same dead record, and fall through to starting fresh.
		_ = serverstate.Clear(tree.State())
		return health, false
	}
	probe := serverstate.ProbeHealth(canonicalOrigin)
	if probe.Err != nil {
		return health, false
	}
	if probe.Health.PID != state.Identity.PID || probe.Health.ReleaseID != releaseID {
		return health, false
	}
	return probe.Health, true
}

func startServer(tree layout.Tree, releaseID string) error {
	exe := filepath.Join(tree.Bin(), serverExeName)
	if _, err := os.Stat(exe); err != nil {
		// Fall back to the release's own copy. The bin\ copy is what the installer puts in place; the
		// release copy is what it was taken from, and either is a legitimate thing to run.
		releaseDir, rerr := tree.Release(releaseID)
		if rerr != nil {
			return err
		}
		exe = filepath.Join(releaseDir, "server", serverExeName)
		if _, err2 := os.Stat(exe); err2 != nil {
			return fmt.Errorf("找不到服务程序 %s", exe)
		}
	}
	cmd := exec.Command(exe, "--root", tree.Root, "--release", releaseID)
	cmd.Dir = tree.Root
	// Detach: the server must outlive the launcher, and must not inherit a console window. The
	// launcher is a GUI-subsystem binary, so there is no console to inherit in the ordinary case; this
	// makes it true when run from a terminal too.
	cmd.SysProcAttr = detachedProcess()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法启动 %s: %w", exe, err)
	}
	// Release the child handle. Keeping it would make the launcher the reaper of a process it is about
	// to outlive, and a terminated-but-unreaped server stays visible to OpenProcess -- which is the
	// confusing state the identity code has to work around.
	_ = cmd.Process.Release()
	return nil
}

func openBrowser(origin, releaseID string) int {
	if err := winproc.OpenInDefaultBrowser(origin + "/"); err != nil {
		fail(fmt.Sprintf(
			"本地服务已就绪（发布版本 %s），但无法自动打开浏览器。\n"+
				"请手动在浏览器地址栏输入： %s/", releaseID, origin), err)
		return exitInternal
	}
	return exitOK
}

func cmdPlatform() int {
	tree, releaseID, err := resolve()
	if err != nil {
		fail("没有找到已安装的版本。", err)
		return exitRelease
	}
	if _, ok := ownedHealthyServer(tree, releaseID); !ok {
		if code := cmdOpen(); code != exitOK {
			return code
		}
	}
	if err := winproc.OpenInDefaultBrowser(canonicalOrigin + "/__civic/platform"); err != nil {
		fail("无法打开浏览器检查页面。", err)
		return exitInternal
	}
	return exitOK
}
