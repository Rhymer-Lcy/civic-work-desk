package main

import (
	"fmt"
	"regexp"
	"strings"
)

// evidence is everything the conclusion is drawn from. Every field is something the report also prints
// in full further down, so a reader can check the conclusion against its inputs.
type evidence struct {
	platformSupported bool
	platformReason    string

	activeRelease    bool
	integrityOK      bool
	missingBinaries  []string
	portForeign      bool
	portOtherInstall bool

	// lastLaunchOutcome is the outcome word of the most recent open or platform line in launch.log, or
	// "" when there is none.
	lastLaunchOutcome string

	srpDefaultDisallowed bool
	srpRules             int
	appLockerRules       int
	smartAppControl      string // "on", "evaluation", "off", or "" when the setting does not exist

	nonCanonicalHostRequests int
}

// finding is one line of the conclusion: a fixed category, and what it means in Chinese.
type finding struct {
	category string
	text     string
}

// The categories the field kit must tell apart. They are fixed words so that reports from several
// machines can be compared by eye.
const (
	catUnsupportedOS   = "unsupported-os"
	catSecurityPolicy  = "security-policy"
	catExecutableBlock = "executable-blocked"
	catPortConflict    = "port-conflict"
	catBrowserLaunch   = "browser-launch"
	catServerFailure   = "server-failure"
	catOriginProfile   = "origin-or-profile"
	catNoneDetected    = "none-detected"
)

var outcomePattern = regexp.MustCompile(`^\S+ (open|platform) outcome=(\S+) `)

// lastLaunchOutcome returns the outcome of the last open or platform attempt in launch.log lines.
func lastLaunchOutcome(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		if m := outcomePattern.FindStringSubmatch(lines[i]); m != nil {
			return m[2]
		}
	}
	return ""
}

// countNonCanonicalHosts counts server.log request lines that carry the non-canonical Host marker.
func countNonCanonicalHosts(lines []string) int {
	n := 0
	for _, line := range lines {
		if strings.Contains(line, " host=") {
			n++
		}
	}
	return n
}

// conclude turns the evidence into the categories a maintainer acts on.
//
// It reports every category the evidence supports rather than choosing one: a machine can have a
// security policy configured AND a port conflict, and hiding the second behind the first would send the
// maintainer after the wrong one.
func conclude(e evidence) []finding {
	var out []finding
	add := func(category, format string, args ...any) {
		out = append(out, finding{category, fmt.Sprintf(format, args...)})
	}

	if !e.platformSupported {
		add(catUnsupportedOS, "这台计算机的系统不在支持范围内：%s", e.platformReason)
	}

	switch e.lastLaunchOutcome {
	case "server-blocked-by-policy":
		add(catSecurityPolicy, "最近一次启动时，本地服务程序被 Windows 安全策略（AppLocker 或软件限制策略）阻止。需要计算机管理员处理。")
	case "server-blocked-by-application-control":
		add(catExecutableBlock, "最近一次启动时，本地服务程序被应用程序控制（例如“智能应用控制”）阻止。本候选版本未进行代码签名。")
	case "server-blocked-by-security-software":
		add(catExecutableBlock, "最近一次启动时，安全软件阻止了本地服务程序，或已将它隔离。")
	case "server-executable-missing":
		add(catExecutableBlock, "最近一次启动时找不到本地服务程序，它可能已被安全软件隔离或删除。")
	case "port-conflict-foreign-program", "port-conflict-other-installation":
		add(catPortConflict, "最近一次启动时，端口 8765 已被占用（%s）。", e.lastLaunchOutcome)
	case "browser-launch-failed":
		add(catBrowserLaunch, "最近一次启动时，本地服务已就绪，但无法自动打开默认浏览器。")
	case "server-start-failed", "server-not-responding":
		add(catServerFailure, "最近一次启动时，本地服务未能正常启动或响应（%s）。", e.lastLaunchOutcome)
	}

	if e.srpDefaultDisallowed || e.srpRules > 0 || e.appLockerRules > 0 {
		add(catSecurityPolicy, "这台计算机配置了程序运行限制策略（软件限制策略默认禁止：%s；软件限制策略规则 %d 条；AppLocker 规则 %d 条）。"+
			"策略可能阻止本程序运行，是否阻止以上方“最近一次启动”的结果为准。",
			yesNo(e.srpDefaultDisallowed), e.srpRules, e.appLockerRules)
	}
	if e.smartAppControl == "on" {
		add(catExecutableBlock, "“智能应用控制”处于开启状态，它可能阻止未签名的程序。")
	}

	if len(e.missingBinaries) > 0 {
		add(catExecutableBlock, "bin 目录中缺少程序文件：%s。它们可能已被安全软件隔离或删除。",
			strings.Join(e.missingBinaries, ", "))
	}
	if e.activeRelease && !e.integrityOK {
		add(catServerFailure, "当前版本的程序文件校验未通过（见第 3 节）。")
	}
	if !e.activeRelease {
		add(catServerFailure, "没有已启用的版本（见第 2 节）。")
	}
	if e.portForeign {
		add(catPortConflict, "此刻端口 8765 被其他程序占用。")
	}
	if e.portOtherInstall {
		add(catPortConflict, "此刻端口 8765 被另一个政务工作记录台安装占用。")
	}

	if e.nonCanonicalHostRequests > 0 {
		add(catOriginProfile, "服务日志中有 %d 个请求不是通过固定访问地址 http://127.0.0.1:8765/ 发出的（例如使用了 localhost）。"+
			"记录只保存在固定访问地址下；通过其他地址打开时看到的是一个空白的程序，原有记录并未丢失。",
			e.nonCanonicalHostRequests)
	}

	if len(out) == 0 {
		add(catNoneDetected, "未发现系统、安全策略、程序文件、端口、浏览器启动或本地服务方面的问题。"+
			"如果记录“不见了”，请确认使用的是同一个浏览器、同一个浏览器用户配置，并且地址栏是 http://127.0.0.1:8765/ 。")
	}
	return out
}
