#!/bin/sh
# CivicWorkDesk — 启动器（政务工作记录台）
#
# Installed as $HOME/.local/bin/civic-work-desk and invoked by the desktop entry.
#
#   civic-work-desk               start if needed, verify, open the browser
#   civic-work-desk --no-browser  everything except opening the browser (diagnostics)
#   civic-work-desk --restart     stop our own server first, then the normal flow
#
# ## The order of operations is the whole design
#
# The browser is opened LAST, and only after the server has been proven to be serving *this* release
# at *the* canonical origin. The failure this guards against is specific and nasty: a browser opened
# against a server that is not answering, or one still serving the previous release, shows either a
# white screen or an application whose IndexedDB is fine but whose code is stale — and the user reads
# both as "the program is broken" or, worse, "my data is gone".
#
# A TCP connect is not a health check. See civic_health in civic-lib.sh for the three assertions.

set -eu

LIB="$HOME/.local/share/civic-work-desk/lib/civic-lib.sh"
[ -r "$LIB" ] || {
  printf '错误：未找到运行库 %s，安装可能不完整。请重新运行 install.sh。\n' "$LIB" >&2
  exit 1
}
# shellcheck source=/dev/null
. "$LIB"

OPEN_BROWSER=yes
RESTART=no
for arg in "$@"; do
  case "$arg" in
    --no-browser) OPEN_BROWSER=no ;;
    --restart) RESTART=yes ;;
    -h | --help)
      printf '用法：civic-work-desk [--no-browser] [--restart]\n'
      printf '  不带参数：必要时启动本地服务，确认无误后打开浏览器。\n'
      printf '  --no-browser：只启动并检查，不打开浏览器。\n'
      printf '  --restart：先停止本程序自己的服务，再按正常流程启动。\n'
      exit 0
      ;;
    *) civic_die "无法识别的参数：$arg" ;;
  esac
done

# ---------------------------------------------------------------- 1. paths and release
civic_require_install
RELEASE="$(civic_active_release)"
[ -n "$RELEASE" ] || civic_die "无法确定当前启用的版本（$CIVIC_CURRENT 指向异常）。请重新安装。"

mkdir -p "$CIVIC_RUN" "$CIVIC_LOGDIR"
civic_log "launch requested release=$RELEASE"

# ---------------------------------------------------------------- 2. single-launcher lock
#
# Double-clicking a menu entry twice in quick succession must not start two servers. `mkdir` is the
# atomic primitive available in POSIX sh; the loser of the race waits for the winner instead of
# proceeding. A lock whose owner is gone is stale — that happens on a kill or a power loss — and is
# broken only after confirming the recorded PID no longer exists.
LOCK="$CIVIC_RUN/launcher.lock"
acquired=no
i=0
while [ "$i" -lt 30 ]; do
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCK/pid"
    acquired=yes
    break
  fi
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    civic_log "breaking stale launcher lock (holder=$holder gone)"
    rm -f "$LOCK/pid"
    rmdir "$LOCK" 2>/dev/null || true
    continue
  fi
  sleep 1
  i=$((i + 1))
done
[ "$acquired" = yes ] || civic_die "另一个启动过程仍在进行中，请稍后再试。"

release_lock() {
  rm -f "$LOCK/pid"
  rmdir "$LOCK" 2>/dev/null || true
}
trap release_lock EXIT INT TERM

# ---------------------------------------------------------------- 3. inspect existing server
PID="$(civic_server_pid)"

if [ "$RESTART" = yes ] && [ -n "$PID" ]; then
  civic_note "正在停止本程序的服务（PID $PID）…"
  civic_server_stop >/dev/null || true
  PID=""
fi

REUSED=no
if [ -n "$PID" ]; then
  STATUS="$(civic_health "$RELEASE" || true)"
  case "$STATUS" in
    ok)
      REUSED=yes
      civic_log "reusing healthy server pid=$PID"
      ;;
    release-mismatch:*)
      # Expected after an upgrade: BusyBox resolves its document root once at startup, so a server
      # started before the release switch keeps serving the old directory. Ours, so we restart it.
      civic_note "检测到本地服务仍在提供旧版本，正在重启以启用 $RELEASE …"
      civic_log "restarting: $STATUS expected=$RELEASE"
      civic_server_stop >/dev/null || true
      PID=""
      ;;
    *)
      civic_note "本地服务无响应（$STATUS），正在重启…"
      civic_log "restarting: health=$STATUS"
      civic_server_stop >/dev/null || true
      PID=""
      ;;
  esac
fi

# ---------------------------------------------------------------- 4. start if needed
if [ -z "$PID" ]; then
  if [ "$(civic_http_client)" = none ]; then
    civic_die "本机没有可用的 HTTP 客户端（curl / wget / nc），无法验证服务是否正常。为避免打开一个无法确认的页面，已停止。"
  fi
  PID="$(civic_server_start "$RELEASE")"
  civic_note "已启动本地服务（PID $PID）。"
fi

# ---------------------------------------------------------------- 5. health gate
#
# Up to ten seconds. The loop exists because a just-started server may not have accepted its first
# connection yet; it is not a retry over a failing server, which is why the reason is reported.
HEALTH=""
i=0
while [ "$i" -lt 10 ]; do
  HEALTH="$(civic_health "$RELEASE" || true)"
  [ "$HEALTH" = ok ] && break
  sleep 1
  i=$((i + 1))
done

if [ "$HEALTH" != ok ]; then
  civic_log "health gate failed: $HEALTH"
  printf '错误：本地服务未通过检查，已停止，不会打开浏览器。\n' >&2
  printf '原因：' >&2
  case "$HEALTH" in
    no-response) printf '服务没有响应。\n' >&2 ;;
    no-release-id) printf '服务返回的版本信息无法解析。\n' >&2 ;;
    release-mismatch:*) printf '服务提供的版本与当前启用版本不一致（%s）。\n' "$HEALTH" >&2 ;;
    no-index) printf '服务无法返回首页。\n' >&2 ;;
    entry-mismatch) printf '首页引用的程序文件与版本记录不一致，程序文件可能不完整。\n' >&2 ;;
    *) printf '%s\n' "$HEALTH" >&2 ;;
  esac
  printf '\n诊断信息：%s\n' "$CIVIC_LOG" >&2
  printf '服务输出：%s\n' "$CIVIC_HTTPD_LOG" >&2
  printf '查看状态：civic-work-desk-status\n' >&2
  exit 1
fi

if [ "$REUSED" = yes ]; then
  civic_note "本地服务已在运行且状态正常（PID $PID）。"
fi
civic_note "版本：$RELEASE"
civic_note "地址：$CIVIC_ORIGIN"

# ---------------------------------------------------------------- 6. open the browser
#
# Through xdg-open, i.e. the desktop's own default-browser association, which on the tested target
# resolves to com.360.browser-stable.desktop. The 360 executable is deliberately NOT hard-coded: the
# user's default profile is the one holding the data, and invoking the binary directly risks a
# different profile and therefore an apparently empty application.
if [ "$OPEN_BROWSER" = no ]; then
  civic_note "（按要求未打开浏览器。）"
  exit 0
fi

command -v xdg-open >/dev/null 2>&1 \
  || civic_die "未找到 xdg-open，无法自动打开浏览器。请手动在浏览器中访问 $CIVIC_ORIGIN"

civic_log "opening browser at canonical origin"
xdg-open "$CIVIC_ORIGIN" >>"$CIVIC_LOG" 2>&1 &
civic_note "已请求在默认浏览器中打开。"
