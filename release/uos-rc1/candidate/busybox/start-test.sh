#!/bin/sh
# CivicWorkDesk — RC1 candidate A: BusyBox httpd
#
# Serves the bundled production build at the canonical origin for target acceptance testing.
# This is a TEST launcher, not the final installed launcher: it lives inside the RC1 bundle, serves
# from the bundle, and writes its runtime state beside itself so nothing is installed anywhere.
#
#   canonical origin: http://127.0.0.1:8765/
#
# Usage:
#   sh start-test.sh          # start in the background, print the result
#   sh start-test.sh -f       # run in the foreground (Ctrl-C to stop); useful for reading errors
#
# Why BusyBox is candidate A: it is already on the target, needs no language runtime, binds a
# specified address and port, and serves a chosen document root. What is NOT assumed is which
# options and MIME types this particular build was compiled with — that is what the acceptance test
# measures, with `busybox httpd --help` from the probe and real response headers from curl/wget.

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
APP_DIR="$BUNDLE_DIR/app"
CONF_FILE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/httpd.conf"
STATE_DIR="$BUNDLE_DIR/.runtime"
PID_FILE="$STATE_DIR/busybox-httpd.pid"
LOG_FILE="$STATE_DIR/busybox-httpd.log"

HOST="127.0.0.1"
PORT="8765"
ORIGIN="http://$HOST:$PORT/"

FOREGROUND=no
if [ "${1:-}" = "-f" ]; then FOREGROUND=yes; fi

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

# ---------------------------------------------------------------- preconditions

command -v busybox >/dev/null 2>&1 || fail "未找到 busybox，无法使用候选方案 A。"
busybox --list 2>/dev/null | grep -qx httpd || fail "此 busybox 未编译 httpd 小程序，无法使用候选方案 A。"
[ -d "$APP_DIR" ] || fail "未找到应用目录：$APP_DIR"
[ -f "$APP_DIR/index.html" ] || fail "应用目录中缺少 index.html：$APP_DIR"

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------- already running?
#
# A stale PID file is normal after a crash or a reboot, and a PID can be reused by an unrelated
# process, so the file alone proves nothing. The check is: does that PID exist *and* does it look
# like our httpd? If the PID exists but is something else, we say so and stop rather than guessing.

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    CMD=""
    if [ -r "/proc/$OLD_PID/cmdline" ]; then
      CMD="$(tr '\0' ' ' <"/proc/$OLD_PID/cmdline" 2>/dev/null || true)"
    fi
    case "$CMD" in
      *httpd*"$PORT"*)
        printf '服务已在运行（PID %s）。\n地址：%s\n' "$OLD_PID" "$ORIGIN"
        exit 0
        ;;
      *)
        fail "PID 文件指向进程 $OLD_PID，但它不是本程序的服务。请人工确认后再启动。"
        ;;
    esac
  fi
  rm -f "$PID_FILE"
fi

# ---------------------------------------------------------------- port check
#
# Checked before binding so the failure message names the port rather than surfacing a bare
# "bind: Address already in use". Never kill whatever holds it (§24) — only report.

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$PORT " && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q ":$PORT " && return 0
    return 1
  fi
  return 1
}

if port_in_use; then
  printf '错误：端口 %s 已被占用。\n' "$PORT" >&2
  printf '本程序不会结束占用端口的进程。请先确认占用者：\n' >&2
  printf '    ss -ltnp | grep %s\n' "$PORT" >&2
  exit 1
fi

# ---------------------------------------------------------------- start
#
# `-f` foreground, `-p ADDR:PORT` bind, `-h DIR` document root. Binding is written as
# 127.0.0.1:8765 rather than just the port: `-p 8765` alone would listen on every interface, which
# would put the application on the LAN.
#
# `-c` (config file) is passed only when the file exists, because a build without config support
# would reject the option and the server would not start at all. The acceptance test records
# whether the MIME types from that file actually take effect.

CONF_ARGS=""
if [ -f "$CONF_FILE" ]; then
  CONF_ARGS="-c $CONF_FILE"
fi

if [ "$FOREGROUND" = yes ]; then
  printf '前台运行 BusyBox httpd。地址：%s\n按 Ctrl-C 停止。\n' "$ORIGIN"
  # shellcheck disable=SC2086 # CONF_ARGS is a deliberate two-token expansion
  exec busybox httpd -f -p "$HOST:$PORT" -h "$APP_DIR" $CONF_ARGS
fi

# shellcheck disable=SC2086
busybox httpd -f -p "$HOST:$PORT" -h "$APP_DIR" $CONF_ARGS >"$LOG_FILE" 2>&1 &
NEW_PID=$!
printf '%s\n' "$NEW_PID" >"$PID_FILE"

# Give it a moment, then confirm it is actually alive. A PID that exits immediately (bad option,
# bind failure) must be reported as a failure, not as a successful start.
sleep 1
if ! kill -0 "$NEW_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  printf '错误：BusyBox httpd 启动后立即退出。日志：\n' >&2
  [ -f "$LOG_FILE" ] && sed 's/^/    /' "$LOG_FILE" >&2
  exit 1
fi

printf '已启动 BusyBox httpd（PID %s）。\n' "$NEW_PID"
printf '地址：%s\n' "$ORIGIN"
printf '文档根目录：%s\n' "$APP_DIR"
printf '日志：%s\n' "$LOG_FILE"
printf '停止：sh %s\n' "$(dirname -- "$0")/stop-test.sh"
