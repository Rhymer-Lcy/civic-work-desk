#!/bin/sh
# CivicWorkDesk RC1.1 — capture HTTP response evidence from the running candidate server.
#
#   sh scripts/capture-http-evidence.sh [标签]
#
# 标签 default: "server". Use `busybox` or `python` so the file says which candidate produced it.
# Output: .runtime/headers-<标签>-<时间>.txt — picked up automatically by collect-results.sh.
#
# ## Why this exists
#
# RC1 asked the tester to paste a long command block and substitute the real asset filenames by hand.
# Two things went wrong with that:
#
#   1. the CSS asset was never actually requested, although the result sheet asked for its
#      Content-Type — so the sheet could only have been filled in by guessing;
#   2. the traversal probe was written as `curl http://…/../SHA256SUMS.txt`, and curl **normalises
#      `/../` out of the path before sending**. That request never tested traversal at all: it asked
#      for `/SHA256SUMS.txt`, got a 404 because the file is outside the document root, and looked
#      like a pass. A check that cannot fail is worse than no check.
#
# This script discovers the real entry assets from the bundle, and sends genuinely raw traversal
# paths — with `curl --path-as-is`, or, if curl is missing, with a tiny stdlib Python probe that
# writes the request line itself. Python here is an *acceptance tool*, not a production choice.
#
# Collects: request line, status, and the response headers that matter. Response **bodies are not
# saved**, with one deliberate exception: for the traversal probes the first bytes are inspected in
# memory to assert that the manifest's content did not come back. Nothing about the user is read.

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
APP_DIR="$BUNDLE_DIR/app"
STATE_DIR="$BUNDLE_DIR/.runtime"

HOST="127.0.0.1"
PORT="8765"
BASE="http://$HOST:$PORT"

LABEL="${1:-server}"
STAMP="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown-time)"
OUT="$STATE_DIR/headers-$LABEL-$STAMP.txt"

mkdir -p "$STATE_DIR"

[ -d "$APP_DIR" ] || {
  printf '错误：未找到应用目录：%s\n' "$APP_DIR" >&2
  exit 2
}

# ---------------------------------------------------------------- entry asset discovery
#
# Read from the bundle on disk, not typed by the tester. `deployment-health.json` records the entry
# filenames the build produced; the directory listing is the fallback if that file is ever absent.

ENTRY_JS=""
ENTRY_CSS=""
HEALTH="$APP_DIR/deployment-health.json"
if [ -r "$HEALTH" ]; then
  ENTRY_JS="$(sed -n 's/.*"js"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HEALTH" | head -n 1)"
  ENTRY_CSS="$(sed -n 's/.*"css"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HEALTH" | head -n 1)"
fi
if [ -z "$ENTRY_JS" ]; then
  ENTRY_JS="$(cd "$APP_DIR" && ls assets/index-*.js 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$ENTRY_CSS" ]; then
  ENTRY_CSS="$(cd "$APP_DIR" && ls assets/index-*.css 2>/dev/null | head -n 1 || true)"
fi

[ -n "$ENTRY_JS" ] || {
  printf '错误：无法确定入口 JS 文件名。\n' >&2
  exit 2
}
[ -n "$ENTRY_CSS" ] || {
  printf '错误：无法确定入口 CSS 文件名。\n' >&2
  exit 2
}

# ---------------------------------------------------------------- tooling

HAVE_CURL=no
command -v curl >/dev/null 2>&1 && HAVE_CURL=yes
HAVE_PY=no
command -v python3 >/dev/null 2>&1 && HAVE_PY=yes
RAW_PROBE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/raw-path-probe.py"

out() { printf '%s\n' "$*" >>"$OUT"; }

: >"$OUT"
out "CivicWorkDesk RC1.1 — HTTP 响应证据"
out "label:     $LABEL"
out "collected: $(date -Iseconds 2>/dev/null || date 2>/dev/null || echo unknown)"
out "origin:    $BASE"
out "entry js:  $ENTRY_JS"
out "entry css: $ENTRY_CSS"
out "curl:      $HAVE_CURL"
out "python3:   $HAVE_PY"
out ""
out "本文件只包含请求行、状态码与响应头；除遍历探测的安全断言外不保存响应体。"

# ---------------------------------------------------------------- ordinary requests

fetch_headers() {
  path="$1"
  out ""
  out "------------------------------------------------------------------"
  out "GET $path"
  out "------------------------------------------------------------------"
  if [ "$HAVE_CURL" = yes ]; then
    curl -s -o /dev/null -D - "$BASE$path" 2>&1 | tr -d '\r' >>"$OUT" || out "(请求失败)"
  elif command -v busybox >/dev/null 2>&1; then
    # busybox wget prints response headers to stderr with -S.
    busybox wget -S -q -O /dev/null "$BASE$path" 2>&1 | tr -d '\r' >>"$OUT" || out "(请求失败)"
  elif [ "$HAVE_PY" = yes ]; then
    python3 "$RAW_PROBE" --host "$HOST" --port "$PORT" --raw-path "$path" --headers-only >>"$OUT" 2>&1 ||
      out "(请求失败)"
  else
    out "(本机没有 curl / busybox wget / python3，无法抓取)"
  fi
}

for path in \
  "/" \
  "/index.html" \
  "/sw.js" \
  "/manifest.webmanifest" \
  "/deployment-health.json" \
  "/$ENTRY_JS" \
  "/$ENTRY_CSS" \
  "/assets/"; do
  fetch_headers "$path"
done

# ---------------------------------------------------------------- traversal probes
#
# These must arrive at the server **unnormalised**, or they test nothing. curl rewrites `/../` out of
# the path by default; `--path-as-is` is what stops it. The encoded form `%2e%2e` survives curl's
# normalisation either way and additionally tests whether the *server* decodes-then-resolves, which
# is the classic mistake.

probe_traversal() {
  raw="$1"
  out ""
  out "------------------------------------------------------------------"
  out "TRAVERSAL GET $raw"
  out "------------------------------------------------------------------"

  if [ "$HAVE_CURL" = yes ]; then
    out "(curl --path-as-is：原样发送，不做路径规范化)"
    curl -s --path-as-is -o "$STATE_DIR/.traversal-body" -D - "$BASE$raw" 2>&1 | tr -d '\r' >>"$OUT" ||
      out "(请求失败)"
  elif [ "$HAVE_PY" = yes ]; then
    out "(python3 原始请求行探测)"
    python3 "$RAW_PROBE" --host "$HOST" --port "$PORT" --raw-path "$raw" \
      --body-out "$STATE_DIR/.traversal-body" >>"$OUT" 2>&1 || out "(请求失败)"
  else
    out "(无可用工具发送未规范化路径；本项未测)"
    return 0
  fi

  # The safety assertion: the manifest's content must not have come back. Checked in the body we
  # just fetched, then the body is deleted — it is never part of the returned evidence.
  if [ -s "$STATE_DIR/.traversal-body" ]; then
    if grep -q "SHA256SUMS\|civic-work-desk" "$STATE_DIR/.traversal-body" 2>/dev/null ||
      grep -qE '^[0-9a-f]{64} ' "$STATE_DIR/.traversal-body" 2>/dev/null; then
      out ">>> 断言：失败 —— 响应体疑似包含文档根目录之外的文件内容。请立即记录并停止。"
    else
      out ">>> 断言：通过 —— 响应体不包含清单内容（长度 $(wc -c <"$STATE_DIR/.traversal-body") 字节）。"
    fi
  else
    out ">>> 断言：通过 —— 响应体为空。"
  fi
  rm -f "$STATE_DIR/.traversal-body"
}

probe_traversal "/../SHA256SUMS.txt"
probe_traversal "/%2e%2e/SHA256SUMS.txt"
probe_traversal "/..%2fSHA256SUMS.txt"

out ""
out "=================================================================="
out "END"
out "=================================================================="

printf '已生成响应证据：\n    %s\n' "$OUT"
printf '\n请检查：\n'
printf '  1. 入口 JS 与 CSS 的 Content-Type 是否为 JavaScript / CSS 类型；\n'
printf '  2. 三个 TRAVERSAL 段落的断言是否都是「通过」；\n'
printf '  3. /assets/ 是否返回 404 或 403（不得列出文件名）。\n'
printf '\n如何确认遍历探测「真的发出去了」：\n'
printf '  看服务端日志里收到的请求行。必须出现未经规范化的原始路径，例如\n'
printf '      "GET /../SHA256SUMS.txt HTTP/1.1"\n'
printf '  如果日志里只看到 "GET /SHA256SUMS.txt"，说明路径在客户端被规范化了，\n'
printf '  这一项等于没测（RC1 就是这个问题）。\n'
printf '  BusyBox 的日志在 .runtime/busybox-httpd.log；Python 的在它自己的终端窗口里。\n'
