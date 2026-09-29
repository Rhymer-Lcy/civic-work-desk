package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"syscall"
	"time"

	"civicworkdesk/windows/internal/launchlog"
	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/redact"
	"civicworkdesk/windows/internal/release"
	"civicworkdesk/windows/internal/serverstate"
	"civicworkdesk/windows/internal/winproc"
)

// detachedProcess makes the started server independent of the launcher.
//
// DETACHED_PROCESS gives it no console, so nothing flashes on screen and it does not die when a
// terminal that happened to start the launcher is closed. CREATE_NEW_PROCESS_GROUP keeps a Ctrl+C in
// that terminal from reaching it -- the server's lifetime belongs to the stop command, not to whatever
// window a user happened to launch from.
func detachedProcess() *syscall.SysProcAttr {
	const (
		detachedProcessFlag       = 0x00000008
		createNewProcessGroupFlag = 0x00000200
	)
	return &syscall.SysProcAttr{
		CreationFlags: detachedProcessFlag | createNewProcessGroupFlag,
		HideWindow:    true,
	}
}

// describeRelease names a release the way a tester reads it: the version they were told to install,
// then the release id that identifies the exact build. RC1-RC3 carry no display version and are shown by
// their id alone.
func describeRelease(tree layout.Tree, releaseID string) string {
	dir, err := tree.Release(releaseID)
	if err != nil {
		return releaseID
	}
	v, err := release.ReadVersion(dir)
	if err != nil || v.Get("displayVersion") == "" {
		return releaseID
	}
	return fmt.Sprintf("%s（%s）", v.Get("displayVersion"), releaseID)
}

// describeRollbackTarget reports previous.txt, and says plainly when going back to it is not safe.
//
// RC1-RC3 printed previous.txt as "可回退版本" unconditionally. After an upgrade to 0.2.0 that names RC3,
// and RC3 against 0.2.0's records drops sub-task links on edit -- so offering it as a rollback target
// would be offering a way to damage data. civic-admin refuses that rollback; this line says why.
func describeRollbackTarget(tree layout.Tree, active release.Generation, activeKnown bool) string {
	prev, err := tree.PreviousRelease()
	if err != nil {
		return "（无）"
	}
	dir, err := tree.Release(prev)
	if err != nil {
		return fmt.Sprintf("（无）上一版本 %s 无法识别", prev)
	}
	target, err := release.DataGeneration(dir)
	if err != nil || !activeKnown {
		return fmt.Sprintf("（无）无法确认上一版本 %s 的数据格式，不能安全回退", prev)
	}
	if release.CheckTransition(active, target) != nil {
		return fmt.Sprintf("（无）上一版本 %s 使用较旧的数据格式（第 %d 版），回退可能损坏记录，已禁止",
			describeRelease(tree, prev), target.Schema)
	}
	return describeRelease(tree, prev)
}

func cmdStatus() int {
	tree, err := layout.Default()
	if err != nil {
		fail("无法定位安装目录。", err)
		return exitInternal
	}
	say("政务工作记录台 — 运行状态\n\n")
	say("  安装目录     : %s\n", tree.Root)

	releaseID, err := tree.ActiveRelease()
	var active release.Generation
	activeKnown := false
	if err != nil {
		say("  当前版本     : （无）%v\n", err)
	} else {
		say("  当前版本     : %s\n", describeRelease(tree, releaseID))
		if dir, derr := tree.Release(releaseID); derr == nil {
			if g, gerr := release.DataGeneration(dir); gerr == nil {
				active, activeKnown = g, true
				say("  数据格式     : 第 %d 版\n", g.Schema)
			} else {
				say("  数据格式     : 无法确定（%v）\n", gerr)
			}
		}
	}
	say("  可回退版本   : %s\n", describeRollbackTarget(tree, active, activeKnown))
	if ids, err := tree.InstalledReleases(); err == nil {
		say("  已安装版本   : %v\n", ids)
	}
	say("  固定访问地址 : %s/\n\n", canonicalOrigin)

	// Report the three questions separately, because they have different answers and conflating them is
	// how a port conflict gets misread as a crash: is something listening, is it ours, is our recorded
	// process still the one running.
	occupied := serverstate.PortOccupied(canonicalHostPort)
	say("  端口 8765    : %s\n", map[bool]string{true: "有程序在监听", false: "空闲"}[occupied])

	probe := serverstate.ProbeHealth(canonicalOrigin)
	switch {
	case !occupied:
		say("  本地服务     : 未运行\n")
	case probe.Err != nil:
		say("  本地服务     : 端口被占用，但不是政务工作记录台（%v）\n", probe.Err)
	default:
		say("  本地服务     : 正在运行  程序版本 %s  PID %d\n", probe.Health.ReleaseID, probe.Health.PID)
		say("  服务安装目录 : %s\n", redact.Paths(probe.Health.InstallRoot))
		say("  启动时间     : %s\n", probe.Health.StartedAt)
	}

	state, serr := serverstate.Read(tree.State())
	if serr != nil {
		say("  进程记录     : 无（%v）\n", serr)
	} else {
		proven, why := winproc.VerifyOwned(state.Identity, tree.Root, releaseID)
		if proven {
			say("  进程记录     : 已核验属于本安装  PID %d\n", state.Identity.PID)
		} else {
			say("  进程记录     : 记录已失效，不会据此结束任何进程 — %s\n", why)
		}
	}

	if releaseID != "" {
		if dir, derr := tree.Release(releaseID); derr == nil {
			if res, verr := release.Verify(dir); verr != nil {
				say("  程序完整性   : 无法校验（%v）\n", verr)
			} else if res.OK() {
				say("  程序完整性   : 校验通过（%s）\n", res.Summary())
			} else {
				say("  程序完整性   : 校验未通过（%s）\n", res.Summary())
			}
		}
	}
	return exitOK
}

func cmdStop() int {
	tree, err := layout.Default()
	if err != nil {
		fail("无法定位安装目录。", err)
		return exitInternal
	}
	releaseID, err := tree.ActiveRelease()
	if err != nil {
		fail("没有找到已安装的版本。", err)
		return exitRelease
	}

	lock, err := winproc.AcquireLock(filepath.Join(tree.State(), lockFileName))
	if err != nil && !errors.Is(err, winproc.ErrLockBusy) {
		fail("无法获取操作锁。", err)
		return exitInternal
	}
	if lock != nil {
		defer lock.Release()
	}

	state, err := serverstate.Read(tree.State())
	if err != nil {
		if serverstate.PortOccupied(canonicalHostPort) {
			say("端口 8765 上有程序在监听，但没有本安装启动的本地服务记录。\n")
			say("程序不会强行结束无法确认归属的进程。\n")
			record(tree, "stop", launchlog.StopRefused, exitOK, releaseID,
				errors.New("port 8765 is held and no state file records a server of ours"))
			return exitOK
		}
		say("本地服务未在运行。\n")
		return exitOK
	}

	// Graceful first. The server closes its listener, finishes in-flight responses and removes its own
	// state file, which is a cleaner end than a kill and leaves nothing to tidy up.
	//
	// Using the shutdown token is at least as strong a proof of ownership as the PID check that follows:
	// only a process holding the token from our own state directory will honour the request, so an
	// unrelated program cannot be stopped this way however wrong the recorded PID is.
	if err := serverstate.RequestShutdown(canonicalOrigin, state.ShutdownToken); err == nil {
		if waitUntilPortFree(5 * time.Second) {
			// The listener closing is not the process exiting. Waiting for the process, and then clearing
			// the record ourselves, is what makes "已停止" true at the moment it is printed: without it a
			// caller that immediately asks again sees a live PID and a state file that is about to be
			// removed, and concludes something is wrong. The server clears the same file on its way out,
			// and Clear treats absence as success, so doing it here is a safe belt-and-braces.
			waitUntilExited(state.Identity.PID, 5*time.Second)
			_ = serverstate.Clear(tree.State())
			say("本地服务已停止。\n")
			record(tree, "stop", launchlog.Stopped, exitOK, releaseID, nil)
			return exitOK
		}
	}

	// A record that names a process which is simply gone is not a problem to refuse -- it is a stale
	// file, and the honest answer is "nothing is running". Refusing here made clicking 停止服务 twice
	// produce an error on the second click, which is wrong: the user asked for the service to be
	// stopped, and it is.
	if !winproc.Alive(state.Identity.PID) {
		_ = serverstate.Clear(tree.State())
		say("本地服务未在运行。\n")
		return exitOK
	}

	// The process is alive and the graceful path did not work. Terminate -- but only with proof,
	// re-checked inside Terminate immediately before the kill.
	if err := winproc.Terminate(state.Identity, tree.Root, releaseID); err != nil {
		fail("无法停止本地服务。\n\n"+
			"程序不会强行结束无法确认归属的进程。\n"+
			"这是安全设计：无法确认进程归属时，不执行强制终止操作。", err)
		record(tree, "stop", launchlog.StopRefused, exitInternal, releaseID, err)
		return exitInternal
	}
	if err := serverstate.Clear(tree.State()); err != nil {
		say("警告: %v\n", err)
	}
	say("本地服务已停止。\n")
	record(tree, "stop", launchlog.Stopped, exitOK, releaseID, nil)
	return exitOK
}

// waitUntilExited waits for a PID to stop existing. Returns false on timeout, which callers treat as
// "carry on": the port is already free, so the user's request has been honoured either way.
func waitUntilExited(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !winproc.Alive(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func waitUntilPortFree(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !serverstate.PortOccupied(canonicalHostPort) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(150 * time.Millisecond)
	}
}
