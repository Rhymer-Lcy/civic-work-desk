#!/bin/sh
# CivicWorkDesk — shared runtime library for the installed user-level commands.
#
# Sourced by civic-work-desk, -status, -stop, -uninstall and -rollback. Holds every path, the
# canonical origin, the HTTP client selection, the health check and the process-ownership rules, so
# that all five commands agree by construction rather than by five copies staying in step.
#
# Constraints this file exists to enforce (Phase 3 §5–§7, §12):
#   - no Node, no Python, no Electron, no sudo, no system service, no network;
#   - exactly one origin, http://127.0.0.1:8765/, never substituted or fallen back from;
#   - a process is only ever signalled after its identity has been proven from /proc.

set -eu

# ---------------------------------------------------------------- canonical origin
#
# Frozen. The browser keys IndexedDB on scheme+host+port, so changing any part of this is not a
# configuration change — it is a different, empty database that looks exactly like data loss.
CIVIC_HOST="127.0.0.1"
CIVIC_PORT="8765"
CIVIC_ORIGIN="http://127.0.0.1:8765/"

# ---------------------------------------------------------------- paths
#
# XDG user-level layout. Nothing here is a system path and nothing requires elevation.
CIVIC_PREFIX="$HOME/.local/share/civic-work-desk"
CIVIC_RELEASES="$CIVIC_PREFIX/releases"
CIVIC_CURRENT="$CIVIC_PREFIX/current"
CIVIC_PREVIOUS="$CIVIC_PREFIX/previous"
CIVIC_LIBDIR="$CIVIC_PREFIX/lib"
CIVIC_BIN="$HOME/.local/bin"
CIVIC_DESKTOP_DIR="$HOME/.local/share/applications"
CIVIC_DESKTOP_FILE="$CIVIC_DESKTOP_DIR/civic-work-desk.desktop"
CIVIC_STATE="$HOME/.local/state/civic-work-desk"
CIVIC_LOGDIR="$CIVIC_STATE/logs"
CIVIC_LOG="$CIVIC_LOGDIR/launcher.log"
CIVIC_LOG_OLD="$CIVIC_LOGDIR/launcher.log.1"
CIVIC_HTTPD_LOG="$CIVIC_LOGDIR/httpd.log"

# Runtime state prefers $XDG_RUNTIME_DIR (tmpfs, cleared on logout, which is what we want for a PID
# file). When it is unset — a bare ssh session, for instance — fall back to a persistent directory
# rather than guessing /run/user/<uid>, because guessing a path we cannot write to fails later and
# less clearly.
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "${XDG_RUNTIME_DIR:-}" ] && [ -w "${XDG_RUNTIME_DIR:-}" ]; then
  CIVIC_RUN="$XDG_RUNTIME_DIR/civic-work-desk"
else
  CIVIC_RUN="$CIVIC_STATE/run"
fi
CIVIC_PID_FILE="$CIVIC_RUN/httpd.pid"
CIVIC_ROOT_FILE="$CIVIC_RUN/httpd.root"
CIVIC_RELEASE_FILE="$CIVIC_RUN/httpd.release"
# Process start time in clock ticks since boot, recorded at launch. The identity token that closes the
# PID-reuse window; see civic_pid_is_ours.
CIVIC_START_FILE="$CIVIC_RUN/httpd.starttime"

# ---------------------------------------------------------------- output helpers

civic_die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

civic_note() {
  printf '%s\n' "$1"
}

# Startup/status diagnostics only. Never a request path, never page or form content, never anything
# read out of the browser profile or a backup file (§15).
civic_log() {
  [ -d "$CIVIC_LOGDIR" ] || mkdir -p "$CIVIC_LOGDIR" 2>/dev/null || return 0
  # Bounded by a single rotation at 64 KiB. Deliberately not a glob and not a find -delete: the
  # whole log surface is two files with fixed names, so there is nothing to match and nothing to
  # sweep.
  if [ -f "$CIVIC_LOG" ]; then
    size="$(wc -c <"$CIVIC_LOG" 2>/dev/null || echo 0)"
    if [ "$size" -gt 65536 ]; then
      mv -f "$CIVIC_LOG" "$CIVIC_LOG_OLD" 2>/dev/null || true
    fi
  fi
  printf '%s %s\n' "$(date -Iseconds 2>/dev/null || date 2>/dev/null || echo unknown-time)" "$1" \
    >>"$CIVIC_LOG" 2>/dev/null || true
}

# ---------------------------------------------------------------- release identity

# The release id the `current` pointer resolves to, or the empty string when nothing is installed.
civic_active_release() {
  if [ -L "$CIVIC_CURRENT" ] || [ -d "$CIVIC_CURRENT" ]; then
    target="$(readlink "$CIVIC_CURRENT" 2>/dev/null || true)"
    if [ -n "$target" ]; then
      basename "$target"
      return 0
    fi
  fi
  printf ''
}

civic_previous_release() {
  if [ -L "$CIVIC_PREVIOUS" ]; then
    target="$(readlink "$CIVIC_PREVIOUS" 2>/dev/null || true)"
    if [ -n "$target" ]; then
      basename "$target"
      return 0
    fi
  fi
  printf ''
}

civic_app_dir() {
  printf '%s\n' "$CIVIC_CURRENT/app"
}

civic_require_install() {
  [ -d "$CIVIC_PREFIX" ] || civic_die "未检测到安装：$CIVIC_PREFIX 不存在。请先运行 install.sh。"
  [ -e "$CIVIC_CURRENT" ] || civic_die "未检测到已启用的版本：$CIVIC_CURRENT 不存在。请重新运行 install.sh。"
  [ -f "$CIVIC_CURRENT/app/index.html" ] \
    || civic_die "当前版本不完整：缺少 $CIVIC_CURRENT/app/index.html。请重新安装。"
}

# ---------------------------------------------------------------- HTTP client
#
# The health check needs a response *body*, so a TCP connect is not enough (§11). Four clients are
# tried, in order of how precisely they report failure. python3 is deliberately NOT among them: the
# target has it, but making it a fallback would turn it into a runtime dependency, and Stage B
# selected BusyBox precisely so that no language runtime is required (§5).
civic_http_client() {
  if command -v curl >/dev/null 2>&1; then printf 'curl\n'; return 0; fi
  if command -v wget >/dev/null 2>&1; then printf 'wget\n'; return 0; fi
  if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx wget; then
    printf 'busybox-wget\n'; return 0
  fi
  if command -v nc >/dev/null 2>&1; then printf 'nc\n'; return 0; fi
  if command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx nc; then
    printf 'busybox-nc\n'; return 0
  fi
  printf 'none\n'
}

# civic_http_get <path> -> response body on stdout, non-zero exit on failure.
#
# Writes only to stdout; callers assert on the content. The `nc` variants speak HTTP/1.0 and strip
# everything up to the first blank line, which is the header/body separator.
#
# ## Why no `-T` is passed to wget
#
# `busybox wget -q -T 5 -O - <url>` **segfaults** — measured on BusyBox 1.30.1, exit 139, no output;
# the same command without `-T` returns the body correctly. That matters far more than it looks:
# `command -v wget` resolves to BusyBox's wget on a BusyBox-centric system, so a per-client timeout
# flag would have taken down the health gate on exactly the machines this deployment targets, and the
# symptom would have been "the application will not open" while the server was serving perfectly.
#
# So the timeout is applied from outside, with `timeout(1)`, which is one implementation for every
# client instead of four different flags. When `timeout` is absent the requests simply have none:
# worse than a bounded wait, but a launcher that waits is recoverable, and a launcher that segfaults
# its own health check is not.
civic_timeout_prefix() {
  if command -v timeout >/dev/null 2>&1; then
    printf 'timeout 8'
  else
    printf ''
  fi
}

civic_http_get() {
  path="$1"
  url="http://$CIVIC_HOST:$CIVIC_PORT$path"
  tmo="$(civic_timeout_prefix)"
  # shellcheck disable=SC2086 # tmo is a deliberate two-token expansion, empty when unavailable
  case "$(civic_http_client)" in
    curl) $tmo curl -fsS --max-time 5 "$url" 2>/dev/null ;;
    wget) $tmo wget -q -O - "$url" 2>/dev/null ;;
    busybox-wget) $tmo busybox wget -q -O - "$url" 2>/dev/null ;;
    nc)
      printf 'GET %s HTTP/1.0\r\nHost: %s:%s\r\nConnection: close\r\n\r\n' \
        "$path" "$CIVIC_HOST" "$CIVIC_PORT" \
        | $tmo nc "$CIVIC_HOST" "$CIVIC_PORT" 2>/dev/null | tr -d '\r' | sed -e '1,/^$/d'
      ;;
    busybox-nc)
      printf 'GET %s HTTP/1.0\r\nHost: %s:%s\r\nConnection: close\r\n\r\n' \
        "$path" "$CIVIC_HOST" "$CIVIC_PORT" \
        | $tmo busybox nc "$CIVIC_HOST" "$CIVIC_PORT" 2>/dev/null | tr -d '\r' | sed -e '1,/^$/d'
      ;;
    *) return 1 ;;
  esac
}

civic_json_field() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# ---------------------------------------------------------------- health check
#
# Three assertions, and the third is the one that matters:
#
#   1. /deployment-health.json is served and names a release;
#   2. that release equals the release `current` points at — so a server still serving the previous
#      release after an upgrade is detected rather than silently used (BusyBox resolves its document
#      root once, at startup: measured, see docs/phase-3-stage-b-evidence.md);
#   3. the index.html being served references the entry asset that the health file names. This is a
#      cross-check rather than a tautology: it fails if the server is serving some other directory's
#      index.html, or BusyBox's own 404 page, both of which would otherwise look like a pass.
#
# Echoes a machine-readable reason on failure so the caller can decide between "restart it" and
# "stop and tell the operator".
civic_health() {
  expected="$1"

  health="$(civic_http_get /deployment-health.json || true)"
  if [ -z "$health" ]; then
    printf 'no-response\n'
    return 1
  fi

  served="$(printf '%s' "$health" | civic_json_field releaseId)"
  if [ -z "$served" ]; then
    printf 'no-release-id\n'
    return 1
  fi
  if [ -n "$expected" ] && [ "$served" != "$expected" ]; then
    printf 'release-mismatch:%s\n' "$served"
    return 1
  fi

  entry="$(printf '%s' "$health" | civic_json_field js)"
  index="$(civic_http_get /index.html || true)"
  if [ -z "$index" ]; then
    printf 'no-index\n'
    return 1
  fi
  if [ -n "$entry" ]; then
    entry_base="$(basename "$entry")"
    if ! printf '%s' "$index" | grep -q "$entry_base"; then
      printf 'entry-mismatch\n'
      return 1
    fi
  fi

  printf 'ok\n'
}

# ---------------------------------------------------------------- process ownership
#
# Four independent facts must all hold before a PID is treated as ours (§12):
#   - the process exists;
#   - its command line is a BusyBox httpd bound to the canonical host:port;
#   - its document root lies under our own install prefix;
#   - its process start time equals the value recorded when we started it.
#
# The third distinguishes *our* server from another BusyBox httpd the user happens to be running. The
# fourth closes PID reuse. PID reuse is assumed, not hoped against: the file nominates a candidate,
# /proc adjudicates, and the start time is what makes the adjudication an identity check rather than a
# resemblance check — a recycled PID running a coincidentally similar command line cannot forge it.
civic_pid_cmdline() {
  pid="$1"
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true
  fi
}

# Field 22 of /proc/<pid>/stat: the process start time in clock ticks since boot. Immutable for the
# life of the process and not reused with the PID, which is exactly the property needed here.
#
# Parsed by cutting everything up to the LAST ')'. Field 2 is the executable name in parentheses and
# may itself contain spaces and parentheses, so splitting on whitespace from the left is wrong; a
# greedy match to the final ')' is correct. Measured against a process whose name was `we ird) name`.
civic_pid_starttime() {
  pid="$1"
  [ -r "/proc/$pid/stat" ] || return 1
  rest="$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null)" || return 1
  [ -n "$rest" ] || return 1
  # shellcheck disable=SC2086 # deliberate word splitting to index the stat fields
  set -- $rest
  [ $# -ge 20 ] || return 1
  value="${20}"
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$value"
}

civic_pid_is_ours() {
  pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(civic_pid_cmdline "$pid")"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *httpd*) ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    *"$CIVIC_HOST:$CIVIC_PORT"*) ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    *"$CIVIC_PREFIX"*) ;;
    *) return 1 ;;
  esac

  # The start-time token, when we have one. Absent only for a server started by an older version of
  # this library, so its absence weakens the check rather than failing it — but a token that exists
  # and disagrees is decisive, and means the PID now belongs to something else.
  if [ -f "$CIVIC_START_FILE" ]; then
    recorded="$(cat "$CIVIC_START_FILE" 2>/dev/null || true)"
    if [ -n "$recorded" ]; then
      actual="$(civic_pid_starttime "$pid" 2>/dev/null || true)"
      [ -n "$actual" ] || return 1
      [ "$actual" = "$recorded" ] || return 1
    fi
  fi
  return 0
}

# Echoes the PID of our running server, or nothing. Cleans up a PID file that names a process which
# is gone or is no longer ours — that is the stale-PID case, and it is normal after a reboot.
civic_server_pid() {
  [ -f "$CIVIC_PID_FILE" ] || return 0
  pid="$(cat "$CIVIC_PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$CIVIC_PID_FILE"
    return 0
  fi
  case "$pid" in
    *[!0-9]*)
      rm -f "$CIVIC_PID_FILE"
      return 0
      ;;
  esac
  if civic_pid_is_ours "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  civic_log "stale pid file cleared (pid=$pid no longer ours)"
  rm -f "$CIVIC_PID_FILE"
  rm -f "$CIVIC_ROOT_FILE"
  rm -f "$CIVIC_RELEASE_FILE"
  return 0
}

# Is anything at all listening on the canonical port? Used only to produce a clear message before
# attempting a bind — never to identify something to terminate (§21).
civic_port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[.:]$CIVIC_PORT " && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q "[.:]$CIVIC_PORT " && return 0
    return 1
  fi
  return 1
}

civic_port_conflict_message() {
  printf '端口 %s 已被其他进程占用。\n' "$CIVIC_PORT" >&2
  printf '\n' >&2
  printf '本程序不会结束占用端口的进程，也不会改用其他端口——换端口就等于换了一个\n' >&2
  printf '空的数据库，看起来和数据丢失一样。\n' >&2
  printf '\n' >&2
  printf '请先自行确认占用者，处理后重新启动：\n' >&2
  printf '    ss -ltnp | grep %s\n' "$CIVIC_PORT" >&2
}

# ---------------------------------------------------------------- server control

civic_busybox_ok() {
  command -v busybox >/dev/null 2>&1 || return 1
  busybox --list 2>/dev/null | grep -qx httpd || return 1
  return 0
}

# Start the owned server. Assumes callers have already established that we do not have one running.
civic_server_start() {
  release="$1"
  app_dir="$CIVIC_CURRENT/app"
  conf="$CIVIC_CURRENT/runtime/httpd.conf"

  civic_busybox_ok \
    || civic_die "未找到可用的 busybox httpd。本机不满足运行条件，请联系交付方。"
  [ -f "$app_dir/index.html" ] || civic_die "程序文件不完整：缺少 $app_dir/index.html。"

  mkdir -p "$CIVIC_RUN" "$CIVIC_LOGDIR"

  if civic_port_busy; then
    civic_port_conflict_message
    civic_log "start refused: port busy"
    exit 1
  fi

  # httpd.conf carries the MIME table. It is passed only when present, because a BusyBox built
  # without config support rejects -c outright and would fail to start at all.
  conf_args=""
  if [ -f "$conf" ]; then
    conf_args="-c $conf"
  fi

  # A truncated-per-start log: BusyBox httpd writes only startup and error output here, because -v
  # is deliberately not passed, so there is no request logging to grow or to leak paths.
  : >"$CIVIC_HTTPD_LOG" 2>/dev/null || true

  # setsid detaches the server from the launching terminal or desktop session, so closing the
  # terminal that started it does not take the server with it. Absent setsid, a plain background
  # start is used and the server is simply reparented when this script exits.
  # shellcheck disable=SC2086 # conf_args is a deliberate two-token expansion
  if command -v setsid >/dev/null 2>&1; then
    setsid busybox httpd -f -p "$CIVIC_HOST:$CIVIC_PORT" -h "$app_dir" $conf_args \
      >>"$CIVIC_HTTPD_LOG" 2>&1 &
  else
    busybox httpd -f -p "$CIVIC_HOST:$CIVIC_PORT" -h "$app_dir" $conf_args \
      >>"$CIVIC_HTTPD_LOG" 2>&1 &
  fi
  pid=$!

  # The identity token is written BEFORE the PID file, so there is never an instant at which the PID
  # file names a process for which no token exists. A missing token weakens civic_pid_is_ours to the
  # cmdline checks; a wrong one must never be possible.
  start_token="$(civic_pid_starttime "$pid" 2>/dev/null || true)"
  if [ -n "$start_token" ]; then
    printf '%s\n' "$start_token" >"$CIVIC_START_FILE"
  else
    rm -f "$CIVIC_START_FILE"
  fi
  printf '%s\n' "$pid" >"$CIVIC_PID_FILE"
  printf '%s\n' "$app_dir" >"$CIVIC_ROOT_FILE"
  printf '%s\n' "$release" >"$CIVIC_RELEASE_FILE"
  civic_log "started httpd pid=$pid release=$release starttime=${start_token:-unknown}"

  # Confirm it is still alive. An immediate exit means a rejected option or a lost bind race, and
  # must be reported as a failure rather than handed to the health check as if it had started.
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$CIVIC_PID_FILE"
    rm -f "$CIVIC_ROOT_FILE"
    rm -f "$CIVIC_RELEASE_FILE"
    printf '错误：本地服务启动后立即退出。\n' >&2
    if [ -s "$CIVIC_HTTPD_LOG" ]; then
      printf '服务输出：\n' >&2
      sed 's/^/    /' "$CIVIC_HTTPD_LOG" >&2
    fi
    civic_log "httpd exited immediately"
    exit 1
  fi

  printf '%s\n' "$pid"
}

civic_clear_run_state() {
  rm -f "$CIVIC_PID_FILE"
  rm -f "$CIVIC_ROOT_FILE"
  rm -f "$CIVIC_RELEASE_FILE"
  rm -f "$CIVIC_START_FILE"
}

# Stop the owned server.
#
# Exit status: 0 stopped · 1 nothing of ours was running · 2 the PID stopped being ours mid-stop and
# was deliberately NOT signalled further. Echoes the PID on 0.
#
# ## Why ownership is re-checked before every signal
#
# The earlier version validated once, sent TERM, waited ten seconds, then sent SIGKILL to the same
# number. Those ten seconds are a PID-reuse window: the server can exit during them, the kernel can
# hand its PID to something unrelated, and the SIGKILL then lands on a stranger. The probability is
# low and the consequence — killing someone else's process — is exactly what this deployment promises
# it will never do, so it is re-checked rather than reasoned about.
#
# The re-check is the full identity test, including the start-time token, so a recycled PID whose
# command line happens to resemble ours still fails it. And when the check fails, the response is to
# stop and report, never to escalate: an unproven SIGKILL is worse than a stop that did not complete.
civic_server_stop() {
  pid="$(civic_server_pid)"
  if [ -z "$pid" ]; then
    return 1
  fi

  # TERM. Ownership was just established by civic_server_pid, immediately above.
  kill "$pid" 2>/dev/null || true

  # Up to ten seconds; POSIX sleep counts whole seconds only. A static file server with no transfer in
  # flight exits on the first TERM, so this almost always ends on the first iteration.
  i=0
  while [ "$i" -lt 10 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      civic_clear_run_state
      civic_log "stopped httpd pid=$pid"
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done

  # Still alive after TERM. Re-prove identity before escalating.
  if ! civic_pid_is_ours "$pid"; then
    civic_log "refused to force-stop pid=$pid: identity no longer ours (PID reuse)"
    printf '警告：进程 %s 已不再是本程序的服务（可能是 PID 被复用），\n' "$pid" >&2
    printf '      因此没有对它发送强制结束信号。已清理本程序的运行状态。\n' >&2
    printf '      如需确认当前占用端口 %s 的是什么：ss -ltnp | grep %s\n' "$CIVIC_PORT" "$CIVIC_PORT" >&2
    civic_clear_run_state
    return 2
  fi

  kill -9 "$pid" 2>/dev/null || true

  # And confirm it actually went. A KILL that did not take effect must not be reported as a stop.
  i=0
  while [ "$i" -lt 5 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      civic_clear_run_state
      civic_log "force-stopped httpd pid=$pid"
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done

  civic_log "force-stop did not take effect for pid=$pid"
  printf '错误：进程 %s 未能结束。运行状态未清理，以免丢失它的身份记录。\n' "$pid" >&2
  return 2
}

# ---------------------------------------------------------------- pointer activation
#
# Repoint one of the release pointers (`current` / `previous`) and prove it moved.
#
# Two mechanisms, in order of preference:
#
#   1. a temporary symlink beside the target, then `mv -T`. `rename(2)` is atomic and does not follow
#      symlinks, so there is no window in which the pointer is absent. `-T` is what stops mv from
#      treating a destination that is a symlink-to-directory as a directory to move *into* — the
#      original defect in this code, where the new pointer landed inside the old release while every
#      command reported success.
#   2. `ln -sfn`, which unlinks and recreates. Not atomic: a crash inside that window leaves no
#      pointer at all. Used only where `mv -T` is unavailable.
#
# Measured on the development host: GNU coreutils mv replaces the pointer correctly under `-T` with
# nothing landing in the old release directory, and BusyBox mv **rejects** `-T` with "invalid option"
# rather than doing something else — so attempting the atomic path and falling back on failure is safe
# in both directions. The target runs GNU coreutils 8.30, which has `-T`.
#
# Either way the result is read back, because the failure this guards against is a command that
# reports success without moving anything.
civic_set_pointer() {
  pointer="$1"
  release="$2"
  target="releases/$release"
  dir="$(dirname "$pointer")"
  tmp="$dir/.civic-pointer.$$"

  rm -f "$tmp"
  ln -s "$target" "$tmp" 2>/dev/null || {
    printf 'pointer-temp-failed\n'
    return 1
  }

  if mv -T "$tmp" "$pointer" 2>/dev/null; then
    method=atomic
  else
    rm -f "$tmp"
    ln -sfn "$target" "$pointer" 2>/dev/null || {
      printf 'pointer-write-failed\n'
      return 1
    }
    method=non-atomic
  fi

  actual="$(readlink "$pointer" 2>/dev/null || true)"
  if [ "$actual" != "$target" ]; then
    printf 'pointer-mismatch:%s\n' "${actual:-none}"
    return 1
  fi
  civic_log "pointer $pointer -> $target ($method)"
  printf 'ok:%s\n' "$method"
}
