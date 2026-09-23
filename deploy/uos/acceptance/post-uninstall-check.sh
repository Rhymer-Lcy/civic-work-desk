#!/bin/sh
# 卸载后检查 — 只核对卸载的结果，不需要安装还在
#
#   sh post-uninstall-check.sh
#
# ## 为什么要单独一个脚本
#
# 主收集脚本 collect-results.sh 采集的正是卸载会删掉的东西：程序文件、菜单项、运行状态、部署日志。
# 所以它必须在卸载**之前**运行。卸载之后要核对的是另一回事——「该删的删了没有，不该删的还在不在」
# ——用不到那些东西，所以单独一个小脚本，另存一个文件名，**不会覆盖**上一步收集到的证据。
#
# 本脚本只读文件系统的存在性，不读取任何文件内容：不看浏览器配置，不看下载目录里的文件内容，
# 也不列出主目录。

set -eu

OUT="civic-work-desk-post-uninstall-$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown).txt"
PREFIX="$HOME/.local/share/civic-work-desk"
BIN="$HOME/.local/bin"
DESKTOP_FILE="$HOME/.local/share/applications/civic-work-desk.desktop"
STATE="$HOME/.local/state/civic-work-desk"

PASS=0
FAIL=0

say() {
  printf '%s\n' "$1" | tee -a "$OUT" >/dev/null
  printf '%s\n' "$1"
}

ck() {
  if [ "$1" = yes ]; then
    PASS=$((PASS + 1))
    say "  [PASS] $2"
  else
    FAIL=$((FAIL + 1))
    say "  [FAIL] $2"
  fi
}

: >"$OUT"
say "CivicWorkDesk 卸载后检查"
say "时间：$(date -Iseconds 2>/dev/null || date 2>/dev/null || echo unknown)"
say ""

say "一、应当已经删除的（CivicWorkDesk 自己的东西）"
ck "$([ -d "$PREFIX" ] && echo no || echo yes)" "程序目录已删除：$PREFIX"
ck "$([ -e "$DESKTOP_FILE" ] && echo no || echo yes)" "菜单项已删除"
ck "$([ -d "$STATE" ] && echo no || echo yes)" "部署日志目录已删除：$STATE"

MISSING=0
for name in civic-work-desk civic-work-desk-status civic-work-desk-stop \
  civic-work-desk-rollback civic-work-desk-uninstall; do
  [ -e "$BIN/$name" ] || MISSING=$((MISSING + 1))
done
ck "$([ "$MISSING" -eq 5 ] && echo yes || echo no)" "五个命令都已删除（实测已删 $MISSING/5）"

say ""
say "二、应当仍然保留的（你的数据，不是程序的）"

# 下载目录：只数文件个数，不看内容，也不列文件名。
#
# `xdg-user-dir DOWNLOAD` 在没有配置 user-dirs 的机器上会回落到 $HOME 本身。那时如果直接拿它当
# 下载目录，就会去数家目录顶层的文件，报出一个与用户备份无关的数字——实测正是这样：明明有一个
# 备份文件在 ~/Downloads 里，却报「0 个文件」。所以把「等于 $HOME」也当作「没查到」。
DL=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  DL="$(xdg-user-dir DOWNLOAD 2>/dev/null || true)"
fi
if [ -z "$DL" ] || [ "$DL" = "$HOME" ] || [ ! -d "$DL" ]; then
  DL="$HOME/Downloads"
fi

if [ -d "$DL" ]; then
  # `wc -l` 而不是 `grep -c ''`：后者在没有匹配时退出码为 1，`|| echo 0` 于是又补一个 0，
  # 变量里就成了两行，消息被截断成「（0」。实测出来的。
  COUNT="$(find "$DL" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
  ck yes "下载目录仍然存在，其中有 $COUNT 个文件（只数个数，未读取内容）：$DL"
else
  say "  [注意] 未找到下载目录，可能本机从未使用过：$DL"
fi

if [ -d "$HOME/.config/com.360.browser" ]; then
  ck yes "360 浏览器配置目录仍然存在（未读取内容）"
else
  say "  [注意] 未找到 360 浏览器配置目录；如果本机确实用的是它，请人工确认。"
fi

say ""
say "三、说明"
say "  · 浏览器里仍然保留着本应用的业务数据（来源 http://127.0.0.1:8765/）。"
say "    卸载不清除站点数据，这是设计如此，不是残留。"
say "  · 重新安装同一地址后，原有记录会重新出现。"
say ""
say "通过 $PASS 项，失败 $FAIL 项。"
if [ "$FAIL" -eq 0 ]; then
  say "RESULT: PASS"
else
  say "RESULT: FAIL —— 请把本文件回传。"
fi

printf '\n已生成：%s\n' "$OUT"
printf '（此文件与卸载前收集的 civic-work-desk-final-results-*.txt 是两份，互不覆盖。）\n'
[ "$FAIL" -eq 0 ] || exit 1
