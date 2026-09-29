package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"civicworkdesk/windows/internal/launchlog"
	"civicworkdesk/windows/internal/layout"
	"civicworkdesk/windows/internal/redact"
	"civicworkdesk/windows/internal/winproc"
)

// dialogTitle is what every dialog this program shows is called.
const dialogTitle = "政务工作记录台"

// feedbackLine ends every failure: the one action an ordinary tester is asked to take.
const feedbackLine = "如问题仍然存在，请从开始菜单运行“政务工作记录台 → 维护工具 → 收集诊断信息”，" +
	"并将生成的诊断文件（TXT）反馈给维护人员。"

// console is decided once. Started from a shortcut there is no console, and everything a person must see
// goes to a dialog instead; started by a script with pipes, the text goes to the pipes as it always did.
var console = winproc.HasConsole()

// transcript collects what status and stop report, so that without a console it can be shown in one
// dialog at the end rather than lost.
var transcript strings.Builder

// failed records that a failure dialog has already been shown, so the end-of-command summary does not
// show the same run a second time.
var failed bool

// say is fmt.Printf for the report a command produces.
func say(format string, args ...any) {
	text := fmt.Sprintf(format, args...)
	transcript.WriteString(text)
	if console {
		fmt.Print(text)
	}
}

// fail explains a failure to the person who clicked.
//
// RC1-RC3 printed this to stderr only. A shortcut-started GUI program has no stderr, so a port conflict,
// a blocked executable or a browser that would not open produced no visible response at all.
func fail(userText string, detail error) {
	failed = true
	text := userText
	if detail != nil {
		text += "\n\n技术细节: " + redact.Paths(detail.Error())
	}
	text += "\n\n" + feedbackLine
	if console {
		fmt.Fprintln(os.Stderr, text)
		return
	}
	winproc.ShowDialog(dialogTitle, text, winproc.DialogError)
}

// showTranscript presents what a status or stop command reported, when there is no console to have
// shown it already.
func showTranscript() {
	if console || failed || transcript.Len() == 0 {
		return
	}
	winproc.ShowDialog(dialogTitle, transcript.String(), winproc.DialogInformation)
}

// record appends one outcome to logs\launch.log. The detail goes through the path redactor, because the
// diagnostics tool forwards this file.
func record(tree layout.Tree, command string, outcome launchlog.Outcome, code int, releaseID string, detail error) {
	if tree.Root == "" {
		return
	}
	redact.MaskInstallRoot(tree.Root)
	e := launchlog.Entry{Time: time.Now(), Command: command, Outcome: outcome, ExitCode: code, Release: releaseID}
	if detail != nil {
		e.Detail = redact.Paths(detail.Error())
	}
	_ = launchlog.Append(tree.Logs(), e)
}
