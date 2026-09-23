#!/bin/sh
# CivicWorkDesk — 回退到上一个程序版本
#
#   civic-work-desk-rollback           交互确认后回退
#   civic-work-desk-rollback --yes     不询问（用于自动化）
#
# ## What rollback is, and what it is not
#
# This switches the `current` pointer back to the previous **static release** and restarts the local
# service. That is a code rollback.
#
# It is NOT a data rollback. The business data lives in the browser's IndexedDB and is untouched by
# this operation — which is exactly why rollback is safe *only* while the older code still understands
# the database it finds. This product does not implement database downgrade, and this script cannot
# detect whether a schema migration has run since the older release was built.
#
# So the rule, stated plainly rather than implied: rollback is supported for the immediately previous
# release, and any release note that introduces a database migration will say that rollback across it
# is not available. When in doubt the correct move is to export a JSON backup, not to gamble on a
# rollback.

set -eu

LIB="$HOME/.local/share/civic-work-desk/lib/civic-lib.sh"
[ -r "$LIB" ] || {
  printf '未安装：找不到运行库 %s\n' "$LIB" >&2
  exit 2
}
# shellcheck source=/dev/null
. "$LIB"

ASSUME_YES=no
for arg in "$@"; do
  case "$arg" in
    --yes | -y) ASSUME_YES=yes ;;
    *)
      printf '错误：无法识别的参数：%s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

civic_require_install

CURRENT_ID="$(civic_active_release)"
PREVIOUS_ID="$(civic_previous_release)"

[ -n "$PREVIOUS_ID" ] || civic_die "没有可回退的版本：未记录上一个版本。"
[ -d "$CIVIC_RELEASES/$PREVIOUS_ID/app" ] \
  || civic_die "上一个版本的程序文件已不存在（$CIVIC_RELEASES/$PREVIOUS_ID），无法回退。"
[ "$PREVIOUS_ID" != "$CURRENT_ID" ] || civic_die "上一个版本与当前版本相同（$CURRENT_ID），无需回退。"

printf 'CivicWorkDesk 政务工作记录台 — 版本回退\n'
printf '======================================================\n\n'
printf '当前版本：%s\n' "$CURRENT_ID"
printf '回退到：  %s\n' "$PREVIOUS_ID"
printf '地址不变：%s\n' "$CIVIC_ORIGIN"
printf '\n'
printf '说明：\n'
printf '  · 只切换程序文件，不改动浏览器中的业务数据；\n'
printf '  · 本产品不支持数据库降级。如果新版本曾执行过数据结构迁移，\n'
printf '    回退后旧版本可能无法正确读取数据——此时应当先导出 JSON 备份；\n'
printf '  · 回退后仍可再次安装新版本。\n'
printf '\n'

if [ "$ASSUME_YES" != yes ]; then
  printf '确认回退？请输入 yes 继续：'
  read -r answer || answer=""
  if [ "$answer" != yes ]; then
    printf '已取消，未做任何更改。\n'
    exit 0
  fi
  printf '\n'
fi

# Swap the two pointers, so a rollback can itself be rolled forward.
#
# `-n` is load-bearing: without it, and with `mv` in place of it, the write silently lands *inside*
# the directory the old symlink pointed at and the pointer never moves — see the note in install.sh.
# Each pointer is read back, because the failure mode is a command that reports success.
set_pointer() {
  pointer="$1"
  release="$2"
  ln -sfn "releases/$release" "$pointer"
  actual="$(readlink "$pointer" 2>/dev/null || true)"
  [ "$actual" = "releases/$release" ] \
    || civic_die "切换失败：$pointer 实际指向「${actual:-（无）}」，期望「releases/$release」。"
}

set_pointer "$CIVIC_PREVIOUS" "$CURRENT_ID"
set_pointer "$CIVIC_CURRENT" "$PREVIOUS_ID"

civic_log "rolled back from $CURRENT_ID to $PREVIOUS_ID"
printf '已切换到 %s。\n' "$PREVIOUS_ID"

# A running server resolved its document root at startup, so it must be restarted or it keeps
# serving the release we just switched away from.
PID="$(civic_server_pid)"
if [ -n "$PID" ]; then
  printf '正在重启本地服务…\n'
  civic_server_stop >/dev/null || true
fi

NEW_PID="$(civic_server_start "$PREVIOUS_ID")"
printf '本地服务已启动（PID %s）。\n' "$NEW_PID"

HEALTH=""
i=0
while [ "$i" -lt 10 ]; do
  HEALTH="$(civic_health "$PREVIOUS_ID" || true)"
  [ "$HEALTH" = ok ] && break
  sleep 1
  i=$((i + 1))
done

if [ "$HEALTH" != ok ]; then
  printf '警告：回退后的健康检查未通过（%s）。\n' "$HEALTH" >&2
  printf '请运行 civic-work-desk-status 查看详情。\n' >&2
  exit 1
fi

printf '\n回退完成，当前提供版本 %s。\n' "$PREVIOUS_ID"
printf '如果浏览器还开着，请刷新页面（或关闭标签页后从菜单重新打开）。\n'
