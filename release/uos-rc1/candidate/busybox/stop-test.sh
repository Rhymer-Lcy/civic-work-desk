#!/bin/sh
# CivicWorkDesk — stop the RC1 BusyBox httpd candidate.
#
# Stops only the process this bundle started, identified by its own PID file and confirmed by
# reading /proc/<pid>/cmdline. It never searches for "whatever is on port 8765" and kills that:
# the port is not proof of ownership, and the thing holding it might be someone else's work.

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
STATE_DIR="$BUNDLE_DIR/.runtime"
PID_FILE="$STATE_DIR/busybox-httpd.pid"
PORT="8765"

if [ ! -f "$PID_FILE" ]; then
  printf '没有找到 PID 文件，服务可能未通过本脚本启动。\n'
  printf '如需确认端口 %s 的占用者：ss -ltnp | grep %s\n' "$PORT" "$PORT"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$PID" ]; then
  rm -f "$PID_FILE"
  printf 'PID 文件为空，已清理。\n'
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  printf '进程 %s 已不存在，已清理 PID 文件。\n' "$PID"
  exit 0
fi

# PID reuse is real: the number in the file may now belong to something entirely different. Confirm
# the command line before signalling anything.
CMD=""
if [ -r "/proc/$PID/cmdline" ]; then
  CMD="$(tr '\0' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
fi

case "$CMD" in
  *httpd*"$PORT"*) ;;
  *)
    printf '错误：PID %s 当前的命令行不是本程序的服务，未执行任何操作。\n' "$PID" >&2
    printf '命令行：%s\n' "${CMD:-（无法读取）}" >&2
    printf '如确认无误，请人工处理。\n' >&2
    exit 1
    ;;
esac

kill "$PID" 2>/dev/null || true

# Wait for it to go away, then escalate once. Ten tries at 0.2 s is two seconds, which is generous
# for a static file server with no open transfers.
i=0
while [ "$i" -lt 10 ]; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf '已停止（PID %s）。\n' "$PID"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done

printf '进程 %s 未在预期时间内退出，发送 KILL。\n' "$PID"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
printf '已强制停止（PID %s）。\n' "$PID"
