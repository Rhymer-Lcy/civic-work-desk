#!/bin/sh
# CivicWorkDesk — 停止本地服务
#
# Stops only the BusyBox httpd this deployment started, and only after /proc has confirmed that the
# PID in our state file is still that process: a BusyBox httpd, bound to the canonical host and port,
# with a document root inside our own install prefix.
#
# What it will never do is look up what is holding port 8765 and terminate that. The port is not
# proof of ownership; the thing holding it may be someone else's work (§12, §21).
#
# Closing the browser does not need to stop this service. Leaving it running costs nothing and makes
# the next launch faster.

set -eu

LIB="$HOME/.local/share/civic-work-desk/lib/civic-lib.sh"
[ -r "$LIB" ] || {
  printf '未安装：找不到运行库 %s\n' "$LIB" >&2
  exit 2
}
# shellcheck source=/dev/null
. "$LIB"

PID="$(civic_server_pid)"

if [ -z "$PID" ]; then
  printf '本程序没有正在运行的服务。\n'
  if civic_port_busy; then
    printf '\n注意：端口 %s 正被其他进程占用，但那不是本程序启动的，未做任何处理。\n' "$CIVIC_PORT"
    printf '如需确认占用者：ss -ltnp | grep %s\n' "$CIVIC_PORT"
  fi
  exit 0
fi

printf '正在停止本地服务（PID %s）…\n' "$PID"

# Three outcomes, and the third must not be reported as a generic failure: it means the library
# deliberately declined to force-kill a PID that had stopped being ours, and it has already explained
# why on stderr. Collapsing that into 「未能停止服务」 would hide the one thing worth knowing.
set +e
STOPPED="$(civic_server_stop)"
STOP_RC=$?
set -e

case "$STOP_RC" in
  0)
    printf '已停止（PID %s）。\n' "${STOPPED:-$PID}"
    printf '\n提示：业务数据保存在浏览器中，停止服务不会影响任何数据。\n'
    exit 0
    ;;
  2)
    printf '\n已按安全规则中止：没有对那个进程发送强制结束信号（原因见上方）。\n' >&2
    printf '本程序的运行状态已清理。如需确认端口 %s 现在被什么占用：\n' "$CIVIC_PORT" >&2
    printf '    ss -ltnp | grep %s\n' "$CIVIC_PORT" >&2
    exit 1
    ;;
  *)
    printf '错误：未能停止服务。请运行 civic-work-desk-status 查看当前状态。\n' >&2
    exit 1
    ;;
esac
