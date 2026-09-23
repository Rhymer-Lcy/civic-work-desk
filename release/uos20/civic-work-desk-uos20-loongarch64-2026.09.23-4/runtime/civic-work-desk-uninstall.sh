#!/bin/sh
# CivicWorkDesk — 卸载
#
#   civic-work-desk-uninstall          交互确认后卸载
#   civic-work-desk-uninstall --yes    不询问（用于自动化）
#
# ## What is removed, and what is deliberately left alone
#
# Removed: the five commands, the desktop entry, the installed releases, the runtime state and this
# deployment's own logs. All of it is CivicWorkDesk-owned, and all of it is reinstallable.
#
# NOT removed, and not offered as an option:
#
#   - the 360 browser profile;
#   - the application's business data, which lives in that browser's IndexedDB for the origin
#     http://127.0.0.1:8765/;
#   - anything in the user's download directory — JSON backups, exported XLSX and DOCX.
#
# The reason is asymmetry of consequence. Deleting program files costs a reinstall; deleting site
# data costs the records, irreversibly, and a script cannot know whether the operator has a current
# backup. So the uninstaller tells the operator what remains and how to remove it deliberately,
# rather than doing it for them.

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

# A guard against a mistyped or empty $HOME turning a targeted delete into something else. The path
# must be non-empty, must end in the name we own, and must look like one of our install trees.
[ -n "${HOME:-}" ] || {
  printf '错误：HOME 未设置，拒绝执行删除。\n' >&2
  exit 1
}
case "$CIVIC_PREFIX" in
  */civic-work-desk) ;;
  *)
    printf '错误：安装路径异常（%s），拒绝执行删除。\n' "$CIVIC_PREFIX" >&2
    exit 1
    ;;
esac

RELEASE="$(civic_active_release)"

printf 'CivicWorkDesk 政务工作记录台 — 卸载\n'
printf '======================================================\n\n'
printf '将删除：\n'
printf '  程序文件      %s\n' "$CIVIC_PREFIX"
printf '  启动命令      %s/civic-work-desk 等 5 个命令\n' "$CIVIC_BIN"
printf '  菜单项        %s\n' "$CIVIC_DESKTOP_FILE"
printf '  运行状态      %s\n' "$CIVIC_RUN"
printf '  部署日志      %s\n' "$CIVIC_LOGDIR"
printf '\n'
printf '不会删除（重要）：\n'
printf '  · 浏览器中的业务数据（IndexedDB，来源 %s）\n' "$CIVIC_ORIGIN"
printf '  · 360 浏览器的配置文件\n'
printf '  · 你导出的 JSON 备份\n'
printf '  · 你导出的 XLSX / DOCX 报表\n'
printf '\n'

if [ "$ASSUME_YES" != yes ]; then
  printf '确认卸载？请输入 yes 继续：'
  read -r answer || answer=""
  if [ "$answer" != yes ]; then
    printf '已取消，未做任何更改。\n'
    exit 0
  fi
  printf '\n'
fi

# ---------------------------------------------------------------- stop our server first
PID="$(civic_server_pid)"
if [ -n "$PID" ]; then
  printf '正在停止本地服务（PID %s）…\n' "$PID"
  civic_server_stop >/dev/null || true
fi

# ---------------------------------------------------------------- commands
for name in civic-work-desk civic-work-desk-status civic-work-desk-stop \
  civic-work-desk-rollback civic-work-desk-uninstall; do
  if [ -e "$CIVIC_BIN/$name" ]; then
    rm -f "$CIVIC_BIN/$name"
    printf '已删除命令：%s\n' "$CIVIC_BIN/$name"
  fi
done

# ---------------------------------------------------------------- desktop entry
if [ -e "$CIVIC_DESKTOP_FILE" ]; then
  rm -f "$CIVIC_DESKTOP_FILE"
  printf '已删除菜单项：%s\n' "$CIVIC_DESKTOP_FILE"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$CIVIC_DESKTOP_DIR" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------- runtime state and logs
if [ -d "$CIVIC_RUN" ]; then
  rm -rf "$CIVIC_RUN"
  printf '已删除运行状态：%s\n' "$CIVIC_RUN"
fi
if [ -d "$CIVIC_STATE" ]; then
  rm -rf "$CIVIC_STATE"
  printf '已删除部署日志：%s\n' "$CIVIC_STATE"
fi

# ---------------------------------------------------------------- program files
if [ -d "$CIVIC_PREFIX" ]; then
  rm -rf "$CIVIC_PREFIX"
  printf '已删除程序文件：%s\n' "$CIVIC_PREFIX"
fi

printf '\n卸载完成'
if [ -n "$RELEASE" ]; then
  printf '（原版本 %s）' "$RELEASE"
fi
printf '。\n\n'

printf '请务必注意：浏览器中仍然保留着本应用的数据。\n'
printf '  · 卸载不会清除来源 %s 的站点数据；\n' "$CIVIC_ORIGIN"
printf '  · 重新安装同一地址后，原有记录仍然可以看到；\n'
printf '  · 若要彻底清除，请在浏览器的「设置 → 隐私 → 站点数据」中删除该来源的数据，\n'
printf '    或在重装后使用应用内「设置 → 危险操作 → 清空全部本机数据」。\n'
printf '  · 清除之前建议先导出一份 JSON 备份。\n'
