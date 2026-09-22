#!/bin/sh
# CivicWorkDesk RC1 — verify the bundle before running anything from it.
#
# Run this FIRST, before the probe and before starting any server. If the bundle did not survive the
# transfer intact, every later result is describing a different set of files than the one that was
# reviewed.
#
# Usage:  sh verify-files.sh
#
# Hashing mechanism is chosen from what the machine already has, in preference order:
#   1. sha256sum          (coreutils; present on a normal UOS)
#   2. busybox sha256sum  (present if BusyBox has the applet)
#   3. openssl dgst       (last resort)
# Nothing is downloaded. If none of the three exists, the script says so and exits non-zero rather
# than pretending the bundle was checked.

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
MANIFEST="$BUNDLE_DIR/SHA256SUMS.txt"

[ -f "$MANIFEST" ] || {
  printf '错误：未找到校验清单：%s\n' "$MANIFEST" >&2
  exit 2
}

HASHER=""
if command -v sha256sum >/dev/null 2>&1; then
  HASHER="sha256sum"
elif command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx sha256sum; then
  HASHER="busybox sha256sum"
elif command -v openssl >/dev/null 2>&1; then
  HASHER="openssl"
else
  printf '错误：本机没有 sha256sum、busybox sha256sum 或 openssl，无法校验。\n' >&2
  printf '不要下载任何工具；请在另一台机器上校验后再传输。\n' >&2
  exit 2
fi

printf '校验工具：%s\n' "$HASHER"
printf '清单：%s\n\n' "$MANIFEST"

cd "$BUNDLE_DIR"

FAILED=0
CHECKED=0

# The manifest is `<hash>  <relative path>`, the standard sha256sum format. It is read line by line
# rather than piped into `sha256sum -c` so that the openssl path can share exactly the same loop and
# report the same way — one behaviour to reason about instead of three.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac

  expected="${line%% *}"
  path="${line#* }"
  # Strip the leading spaces / binary marker that sha256sum writes.
  path="${path# }"
  path="${path#\*}"

  if [ ! -f "$path" ]; then
    printf 'MISSING  %s\n' "$path"
    FAILED=$((FAILED + 1))
    continue
  fi

  case "$HASHER" in
    "sha256sum") actual="$(sha256sum "$path" | cut -d' ' -f1)" ;;
    "busybox sha256sum") actual="$(busybox sha256sum "$path" | cut -d' ' -f1)" ;;
    "openssl") actual="$(openssl dgst -sha256 "$path" | sed 's/.*= *//')" ;;
    *) actual="" ;;
  esac

  CHECKED=$((CHECKED + 1))
  if [ "$actual" = "$expected" ]; then
    printf 'OK       %s\n' "$path"
  else
    printf 'MISMATCH %s\n' "$path"
    printf '         期望 %s\n' "$expected"
    printf '         实际 %s\n' "$actual"
    FAILED=$((FAILED + 1))
  fi
done <"$MANIFEST"

printf '\n已校验 %s 个文件。\n' "$CHECKED"
if [ "$FAILED" -gt 0 ]; then
  printf '结果：失败 —— %s 个文件缺失或不匹配。请勿继续，重新传输整个包。\n' "$FAILED"
  exit 1
fi
printf '结果：通过 —— 所有文件与清单一致。\n'
