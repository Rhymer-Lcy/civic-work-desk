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
STOPPED="$(civic_server_stop || true)"

if [ -n "$STOPPED" ]; then
  printf '已停止。\n'
  printf '\n提示：业务数据保存在浏览器中，停止服务不会影响任何数据。\n'
  exit 0
fi

printf '错误：未能停止服务。请运行 civic-work-desk-status 查看当前状态。\n' >&2
exit 1
