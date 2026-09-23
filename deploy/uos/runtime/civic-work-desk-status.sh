#!/bin/sh
# CivicWorkDesk — 运行状态
#
# Read-only. Starts nothing, stops nothing, changes nothing. Written to be the first thing anyone
# runs when the application "does not open", because it separates the three failures that look
# identical from the outside: the program files are missing, the local service is not running, or
# something else owns the port.
#
# Exit status: 0 healthy · 1 not running or unhealthy · 2 not installed.

set -eu

LIB="$HOME/.local/share/civic-work-desk/lib/civic-lib.sh"
[ -r "$LIB" ] || {
  printf '未安装：找不到运行库 %s\n' "$LIB"
  exit 2
}
# shellcheck source=/dev/null
. "$LIB"

printf 'CivicWorkDesk 政务工作记录台 — 运行状态\n'
printf '======================================================\n\n'

if [ ! -d "$CIVIC_PREFIX" ]; then
  printf '安装状态：未安装（%s 不存在）\n' "$CIVIC_PREFIX"
  exit 2
fi

RELEASE="$(civic_active_release)"
PREVIOUS="$(civic_previous_release)"

printf '安装目录：%s\n' "$CIVIC_PREFIX"
if [ -n "$RELEASE" ]; then
  printf '当前版本：%s\n' "$RELEASE"
else
  printf '当前版本：无法确定（current 指向异常）\n'
fi
if [ -n "$PREVIOUS" ]; then
  printf '上一版本：%s（可用 civic-work-desk-rollback 回退）\n' "$PREVIOUS"
else
  printf '上一版本：无\n'
fi
printf '规范地址：%s\n' "$CIVIC_ORIGIN"
printf '程序文件：%s\n' "$(civic_app_dir)"
printf '运行状态目录：%s\n' "$CIVIC_RUN"
printf '日志：%s\n' "$CIVIC_LOG"
printf '服务输出：%s\n' "$CIVIC_HTTPD_LOG"
printf '检查工具：%s\n' "$(civic_http_client)"
printf '\n'

# ---------------------------------------------------------------- server
PID="$(civic_server_pid)"
if [ -n "$PID" ]; then
  printf '本地服务：运行中，PID %s\n' "$PID"
  ROOT="$(cat "$CIVIC_ROOT_FILE" 2>/dev/null || echo '(未记录)')"
  STARTED_FOR="$(cat "$CIVIC_RELEASE_FILE" 2>/dev/null || echo '(未记录)')"
  printf '  文档根目录：%s\n' "$ROOT"
  printf '  启动时的版本：%s\n' "$STARTED_FOR"

  STATUS="$(civic_health "$RELEASE" || true)"
  case "$STATUS" in
    ok)
      printf '  健康检查：通过（正在提供 %s）\n' "$RELEASE"
      printf '\n结论：一切正常。从开始菜单打开即可，或访问 %s\n' "$CIVIC_ORIGIN"
      exit 0
      ;;
    release-mismatch:*)
      printf '  健康检查：不一致 —— %s\n' "$STATUS"
      printf '\n结论：服务仍在提供旧版本的程序文件。\n'
      printf '处理：运行 civic-work-desk（会自动重启服务），或 civic-work-desk --restart\n'
      exit 1
      ;;
    *)
      printf '  健康检查：失败（%s）\n' "$STATUS"
      printf '\n结论：进程在，但没有正常提供页面。\n'
      printf '处理：civic-work-desk --restart\n'
      exit 1
      ;;
  esac
fi

printf '本地服务：未运行（没有本程序拥有的进程）\n'

# The port matters only for the message. Nothing here identifies a process in order to act on it.
if civic_port_busy; then
  printf '\n注意：端口 %s 正被其他进程占用。\n' "$CIVIC_PORT"
  printf '本程序不会结束它，也不会改用其他端口。请先确认占用者：\n'
  printf '    ss -ltnp | grep %s\n' "$CIVIC_PORT"
  printf '\n结论：需要先释放端口，然后再启动。\n'
  exit 1
fi

printf '端口 %s：空闲\n' "$CIVIC_PORT"
printf '\n结论：未运行，但可以启动。从开始菜单打开，或运行 civic-work-desk\n'
exit 1
