#!/bin/sh
# 收集最终验收证据 — 生成一个可以回传的纯文本文件
#
#   sh collect-results.sh
#
# ## 只收集这些
#
#   1. 安装与版本信息（VERSION、releaseId、安装路径）
#   2. civic-work-desk-status 的输出
#   3. 本部署自己的两个日志（启动诊断、服务输出）
#   4. 菜单项文件的内容
#   5. 安装目录的文件清单（只有文件名和大小）
#   6. 相关工具的存在性与版本（busybox / sha256sum / curl / xdg-open 等）
#
# ## 明确不收集
#
#   · 浏览器配置、Cookie、浏览历史、书签、缓存；
#   · 下载目录里的任何文件（JSON 备份、XLSX、DOCX）；
#   · 任何业务数据；
#   · 主目录的完整清单。
#
# 文件里会出现当前账号名（路径中的 $HOME）。如不希望外传，回传前可自行替换成 user。

set -eu

OUT="civic-work-desk-final-results-$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown).txt"
PREFIX="$HOME/.local/share/civic-work-desk"
LOGDIR="$HOME/.local/state/civic-work-desk/logs"
DESKTOP_FILE="$HOME/.local/share/applications/civic-work-desk.desktop"

section() {
  printf '\n==================================================================\n' >>"$OUT"
  printf '%s\n' "$1" >>"$OUT"
  printf '==================================================================\n' >>"$OUT"
}

: >"$OUT"
printf 'CivicWorkDesk 最终安装形态 — 验收证据\n' >>"$OUT"
printf '收集时间：%s\n' "$(date -Iseconds 2>/dev/null || date 2>/dev/null || echo unknown)" >>"$OUT"
printf '规范地址：http://127.0.0.1:8765/\n' >>"$OUT"
printf '\n本文件不含业务数据、不含浏览器配置、不含下载目录内容。\n' >>"$OUT"

section '1. 系统与架构'
{
  uname -a 2>/dev/null || echo '(uname 不可用)'
  printf 'arch: %s\n' "$(uname -m 2>/dev/null || echo unknown)"
  if [ -r /etc/os-release ]; then
    grep -E '^(NAME|VERSION|VERSION_ID|PRETTY_NAME)=' /etc/os-release 2>/dev/null || true
  fi
} >>"$OUT" 2>&1

section '2. 安装与版本'
if [ -f "$PREFIX/current/VERSION" ]; then
  cat "$PREFIX/current/VERSION" >>"$OUT" 2>&1
else
  printf '（未找到 %s/current/VERSION）\n' "$PREFIX" >>"$OUT"
fi
{
  printf '\ncurrent  -> %s\n' "$(readlink "$PREFIX/current" 2>/dev/null || echo '(无)')"
  printf 'previous -> %s\n' "$(readlink "$PREFIX/previous" 2>/dev/null || echo '(无)')"
} >>"$OUT" 2>&1

section '3. civic-work-desk-status'
if [ -x "$HOME/.local/bin/civic-work-desk-status" ]; then
  "$HOME/.local/bin/civic-work-desk-status" >>"$OUT" 2>&1 || true
else
  printf '（未安装 civic-work-desk-status）\n' >>"$OUT"
fi

section '4. 部署日志（启动诊断，不含请求路径）'
if [ -f "$LOGDIR/launcher.log" ]; then
  tail -n 120 "$LOGDIR/launcher.log" >>"$OUT" 2>&1 || true
else
  printf '（无 launcher.log）\n' >>"$OUT"
fi

section '5. 服务输出（httpd.log）'
printf '说明：不加 -v 时 BusyBox httpd 不记录请求行，所以这里正常应当是空的。\n' >>"$OUT"
printf '空日志不是故障。\n\n' >>"$OUT"
if [ -f "$LOGDIR/httpd.log" ]; then
  if [ -s "$LOGDIR/httpd.log" ]; then
    tail -n 60 "$LOGDIR/httpd.log" >>"$OUT" 2>&1 || true
  else
    printf '(空)\n' >>"$OUT"
  fi
else
  printf '（无 httpd.log）\n' >>"$OUT"
fi

section '6. 菜单项'
if [ -f "$DESKTOP_FILE" ]; then
  cat "$DESKTOP_FILE" >>"$OUT" 2>&1
else
  printf '（未找到 %s）\n' "$DESKTOP_FILE" >>"$OUT"
fi

section '7. 已安装命令'
for name in civic-work-desk civic-work-desk-status civic-work-desk-stop \
  civic-work-desk-rollback civic-work-desk-uninstall; do
  if [ -e "$HOME/.local/bin/$name" ]; then
    ls -l "$HOME/.local/bin/$name" >>"$OUT" 2>&1 || true
  else
    printf '缺失：%s\n' "$name" >>"$OUT"
  fi
done

section '8. 安装目录清单（仅文件名与大小）'
if [ -d "$PREFIX" ]; then
  find "$PREFIX" -type f -exec ls -l {} + 2>/dev/null \
    | awk '{ print $5, $NF }' >>"$OUT" 2>&1 || true
  printf '\n文件总数：%s\n' "$(find "$PREFIX" -type f 2>/dev/null | grep -c '')" >>"$OUT"
else
  printf '（%s 不存在）\n' "$PREFIX" >>"$OUT"
fi

section '9. 工具存在性'
{
  printf 'busybox   : %s\n' "$(command -v busybox 2>/dev/null || echo '(无)')"
  if command -v busybox >/dev/null 2>&1; then
    busybox 2>&1 | head -n 1
    printf 'httpd 组件: '
    if busybox --list 2>/dev/null | grep -qx httpd; then printf 'yes\n'; else printf 'NO\n'; fi
    printf 'wget 组件 : '
    if busybox --list 2>/dev/null | grep -qx wget; then printf 'yes\n'; else printf 'no\n'; fi
    printf 'nc 组件   : '
    if busybox --list 2>/dev/null | grep -qx nc; then printf 'yes\n'; else printf 'no\n'; fi
  fi
  printf 'sha256sum : %s\n' "$(command -v sha256sum 2>/dev/null || echo '(无)')"
  printf 'curl      : %s\n' "$(command -v curl 2>/dev/null || echo '(无)')"
  printf 'wget      : %s\n' "$(command -v wget 2>/dev/null || echo '(无)')"
  printf 'nc        : %s\n' "$(command -v nc 2>/dev/null || echo '(无)')"
  printf 'xdg-open  : %s\n' "$(command -v xdg-open 2>/dev/null || echo '(无)')"
  printf 'setsid    : %s\n' "$(command -v setsid 2>/dev/null || echo '(无)')"
  printf 'ss        : %s\n' "$(command -v ss 2>/dev/null || echo '(无)')"
  printf 'XDG_RUNTIME_DIR: %s\n' "${XDG_RUNTIME_DIR:-(未设置)}"
} >>"$OUT" 2>&1

section '10. 默认浏览器关联（只读查询）'
if command -v xdg-settings >/dev/null 2>&1; then
  printf 'default-web-browser: ' >>"$OUT"
  xdg-settings get default-web-browser >>"$OUT" 2>&1 || printf '(查询失败)\n' >>"$OUT"
else
  printf '（无 xdg-settings）\n' >>"$OUT"
fi
printf '\n说明：以上仅为只读查询，本脚本不修改任何关联，也不读取浏览器配置目录。\n' >>"$OUT"

section 'END'

printf '已生成：%s\n' "$OUT"
printf '\n请连同填好的 RESULT_TEMPLATE.md、Console 输出的那段 JSON，以及端口冲突脚本的输出一起回传。\n'
printf '回传前可检查一遍本文件内容；如不希望外传账号名，可自行把路径里的账号替换为 user。\n'
