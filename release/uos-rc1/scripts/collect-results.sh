#!/bin/sh
# CivicWorkDesk RC1 — collect the acceptance results into one file to return.
#
# Run this LAST, after the probe and after filling in acceptance/RESULT_TEMPLATE.md. It gathers only
# the files this acceptance produced:
#
#   * the probe report            (scripts/civic-work-desk-probe-*.txt)
#   * the completed result sheet  (acceptance/RESULT_TEMPLATE.md, edited in place or copied)
#   * the candidate server logs   (.runtime/*.log)
#   * the header captures         (.runtime/headers-*.txt), if the tester made any
#
# It does NOT walk your home directory, read the browser profile, or collect anything it was not
# told about. Read the resulting file before sending it; you are the last check on what leaves this
# machine.
#
# Usage:  sh collect-results.sh

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown-time)"
OUT="$BUNDLE_DIR/civic-work-desk-uos-rc1-results-$STAMP.txt"

: >"$OUT"

add() { printf '%s\n' "$*" >>"$OUT"; }

add "CivicWorkDesk — UOS RC1 acceptance results"
add "collected: $(date -Iseconds 2>/dev/null || date 2>/dev/null || echo unknown)"
add ""
add "This file was assembled by collect-results.sh from the files listed below and nothing else."

append_file() {
  label="$1"
  path="$2"
  add ""
  add "=============================================================================="
  add "$label"
  add "source: $(basename -- "$path")"
  add "=============================================================================="
  if [ -r "$path" ]; then
    cat "$path" >>"$OUT"
  else
    add "(not present)"
  fi
}

# Probe reports: there may be more than one if the probe was run twice. Include them all, newest
# last, so the sequence of what was observed is legible.
FOUND_PROBE=no
for report in "$BUNDLE_DIR"/scripts/civic-work-desk-probe-*.txt; do
  [ -f "$report" ] || continue
  append_file "PROBE REPORT" "$report"
  FOUND_PROBE=yes
done
if [ "$FOUND_PROBE" = no ]; then
  add ""
  add "WARNING: no probe report found. Run scripts/probe-target.sh first."
fi

for sheet in "$BUNDLE_DIR/acceptance/RESULT_TEMPLATE.md" "$BUNDLE_DIR/acceptance/RESULTS.md"; do
  [ -f "$sheet" ] || continue
  append_file "ACCEPTANCE RESULT SHEET" "$sheet"
done

for log in "$BUNDLE_DIR"/.runtime/*.log; do
  [ -f "$log" ] || continue
  append_file "SERVER LOG" "$log"
done

for capture in "$BUNDLE_DIR"/.runtime/headers-*.txt; do
  [ -f "$capture" ] || continue
  append_file "RESPONSE HEADER CAPTURE" "$capture"
done

add ""
add "=============================================================================="
add "END"
add "=============================================================================="

printf '已生成结果文件：\n    %s\n\n' "$OUT"
printf '请在发送前打开确认内容，然后把该文件回传。\n'
printf '不要发送浏览器配置目录、下载的个人文档或真实业务数据。\n'
