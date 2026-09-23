#!/bin/sh
# CivicWorkDesk — 安装 / 升级（用户级，不需要 sudo）
#
#   sh install.sh              安装或升级到本包所含的版本
#   sh install.sh --force      重新安装同一版本（覆盖已存在的同名版本目录）
#   sh install.sh --no-start   安装完成后不启动本地服务
#
# ## What this does and does not touch
#
# Everything it writes lives under the user's own XDG directories and is CivicWorkDesk-owned:
#
#   ~/.local/share/civic-work-desk/     程序文件（按版本分目录）
#   ~/.local/bin/                       五个命令
#   ~/.local/share/applications/        菜单项
#   ~/.local/state/civic-work-desk/     日志
#
# It never uses sudo, never writes a system path, never installs a package, never registers a
# service, never modifies a system-wide MIME or browser association, and never reads or writes the
# 360 browser profile. The business data is in that browser and is untouched by installing,
# upgrading, rolling back or uninstalling.
#
# ## Integrity before activation
#
# The bundled SHA256SUMS.txt is verified before anything is copied, and the copied release is
# verified again afterwards. A bundle that fails either check is not activated at all — the previous
# release keeps running. Note what the inner manifest can and cannot do: it detects corruption and a
# truncated transfer, but it cannot authenticate the bundle against substitution, because an attacker
# who could rewrite the payload could rewrite the manifest with it. The archive's own .sha256, told
# to the recipient separately, is what does that job.

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"

FORCE=no
START_AFTER=yes
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=yes ;;
    --no-start) START_AFTER=no ;;
    -h | --help)
      printf '用法：sh install.sh [--force] [--no-start]\n'
      exit 0
      ;;
    *)
      printf '错误：无法识别的参数：%s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

printf 'CivicWorkDesk 政务工作记录台 — 安装程序\n'
printf '======================================================\n\n'

# ---------------------------------------------------------------- 1. preconditions
[ -n "${HOME:-}" ] || die "HOME 未设置，无法确定安装位置。"

PREFIX="$HOME/.local/share/civic-work-desk"
RELEASES="$PREFIX/releases"
CURRENT="$PREFIX/current"
PREVIOUS="$PREFIX/previous"
LIBDIR="$PREFIX/lib"
BIN="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/civic-work-desk.desktop"
STATE="$HOME/.local/state/civic-work-desk"

COMMANDS="civic-work-desk civic-work-desk-status civic-work-desk-stop civic-work-desk-rollback civic-work-desk-uninstall"

[ -f "$BUNDLE_DIR/VERSION" ] || die "安装包不完整：缺少 VERSION。"
[ -f "$BUNDLE_DIR/SHA256SUMS.txt" ] || die "安装包不完整：缺少 SHA256SUMS.txt。"
[ -d "$BUNDLE_DIR/app" ] || die "安装包不完整：缺少 app 目录。"
[ -f "$BUNDLE_DIR/app/index.html" ] || die "安装包不完整：缺少 app/index.html。"
[ -d "$BUNDLE_DIR/runtime" ] || die "安装包不完整：缺少 runtime 目录。"

# The server. This is a hard requirement rather than a warning: it is the only thing that serves the
# application, and it was chosen because the target already has it.
command -v busybox >/dev/null 2>&1 \
  || die "本机未找到 busybox，无法运行本程序。请联系交付方。"
busybox --list 2>/dev/null | grep -qx httpd \
  || die "本机的 busybox 未包含 httpd 组件，无法运行本程序。请联系交付方。"

# SHA-256 tool for the integrity check. GNU coreutils on the target; BusyBox as a fallback.
SHA_TOOL=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
elif busybox --list 2>/dev/null | grep -qx sha256sum; then
  SHA_TOOL="busybox sha256sum"
else
  die "本机没有可用的 sha256sum，无法校验安装包完整性。"
fi

RELEASE_ID="$(sed -n 's/^releaseId=//p' "$BUNDLE_DIR/VERSION" | head -n 1)"
[ -n "$RELEASE_ID" ] || die "VERSION 中没有 releaseId，安装包异常。"
case "$RELEASE_ID" in
  */* | *..* | "")
    die "releaseId 含有非法字符：$RELEASE_ID"
    ;;
esac

printf '安装包版本：%s\n' "$RELEASE_ID"
printf '安装位置：  %s\n' "$PREFIX"
printf '校验工具：  %s\n' "$SHA_TOOL"
printf '\n'

# ---------------------------------------------------------------- 2. verify the bundle
printf '正在校验安装包…\n'
MANIFEST_LINES="$(grep -c '' "$BUNDLE_DIR/SHA256SUMS.txt")"
( cd "$BUNDLE_DIR" && $SHA_TOOL -c SHA256SUMS.txt >/dev/null 2>&1 ) \
  || die "安装包校验失败，文件可能在传输中损坏。请重新获取安装包，不要继续安装。"
printf '  通过：%s 个文件与清单一致。\n\n' "$MANIFEST_LINES"

# ---------------------------------------------------------------- 3. existing install
OLD_ID=""
if [ -L "$CURRENT" ]; then
  OLD_TARGET="$(readlink "$CURRENT" 2>/dev/null || true)"
  [ -n "$OLD_TARGET" ] && OLD_ID="$(basename "$OLD_TARGET")"
fi

if [ -n "$OLD_ID" ]; then
  printf '检测到已安装版本：%s\n' "$OLD_ID"
  if [ "$OLD_ID" = "$RELEASE_ID" ] && [ "$FORCE" != yes ]; then
    printf '\n'
    printf '当前已经是这个版本。若要强制重新安装，请运行：\n'
    printf '    sh install.sh --force\n'
    exit 0
  fi
else
  printf '未检测到已安装版本，将进行首次安装。\n'
fi
printf '\n'

# Stop our own server before replacing files. It holds its document root open, and an upgrade must
# not leave it serving a directory that is being rewritten underneath it.
SERVER_WAS_RUNNING=no
if [ -r "$LIBDIR/civic-lib.sh" ]; then
  # shellcheck source=/dev/null
  . "$LIBDIR/civic-lib.sh"
  RUNNING_PID="$(civic_server_pid)"
  if [ -n "$RUNNING_PID" ]; then
    SERVER_WAS_RUNNING=yes
    printf '正在停止本程序的服务（PID %s）…\n' "$RUNNING_PID"
    civic_server_stop >/dev/null || true
  fi
fi

# ---------------------------------------------------------------- 4. stage the new release
TARGET="$RELEASES/$RELEASE_ID"

if [ -d "$TARGET" ]; then
  if [ "$FORCE" = yes ]; then
    printf '覆盖已存在的版本目录：%s\n' "$TARGET"
    rm -rf "$TARGET"
  else
    die "版本目录已存在：$TARGET。若确认要覆盖，请加 --force。"
  fi
fi

printf '正在安装程序文件…\n'
mkdir -p "$TARGET" "$LIBDIR" "$BIN" "$DESKTOP_DIR" "$STATE/logs"
mkdir -p "$TARGET/app" "$TARGET/runtime"
cp -R "$BUNDLE_DIR/app/." "$TARGET/app/"
cp -R "$BUNDLE_DIR/runtime/." "$TARGET/runtime/"
cp "$BUNDLE_DIR/VERSION" "$TARGET/VERSION"
cp "$BUNDLE_DIR/SHA256SUMS.txt" "$TARGET/SHA256SUMS.txt"

# Verify the copy, not just the source. A short read or a full disk produces a truncated file that
# the source-side check above cannot see. Only the lines describing what actually lives in a release
# directory are checked, since install.sh and the README stay in the bundle.
printf '正在校验已安装的文件…\n'
COPIED_MANIFEST="$TARGET/.installed-manifest"
grep -E '^[0-9a-f]{64}[ ]+[*]?(app/|runtime/|VERSION$)' "$TARGET/SHA256SUMS.txt" >"$COPIED_MANIFEST" \
  || die "无法从清单中筛选出已安装文件的校验行。"
COPIED_LINES="$(grep -c '' "$COPIED_MANIFEST")"
[ "$COPIED_LINES" -gt 0 ] || die "筛选后的校验清单为空，拒绝启用该版本。"
if ! ( cd "$TARGET" && $SHA_TOOL -c .installed-manifest >/dev/null 2>&1 ); then
  rm -f "$COPIED_MANIFEST"
  rm -rf "$TARGET"
  die "已安装文件校验失败，已删除该版本目录，原有版本未受影响。"
fi
rm -f "$COPIED_MANIFEST"
printf '  通过：%s 个文件。\n\n' "$COPIED_LINES"

# ---------------------------------------------------------------- 5. commands and library
printf '正在安装命令…\n'
cp "$TARGET/runtime/civic-lib.sh" "$LIBDIR/civic-lib.sh"
chmod 644 "$LIBDIR/civic-lib.sh"
for name in $COMMANDS; do
  [ -f "$TARGET/runtime/$name.sh" ] || die "安装包缺少 runtime/$name.sh。"
  cp "$TARGET/runtime/$name.sh" "$BIN/$name"
  chmod 755 "$BIN/$name"
  printf '  %s\n' "$BIN/$name"
done
printf '\n'

# ---------------------------------------------------------------- 6. activate
#
# `ln -sfn` and then read the result back.
#
# Both halves of that matter. The earlier version of this step wrote the new link under a temporary
# name and `mv -f`'d it into place, on the assumption that rename is atomic and therefore safer.
# It is — but `mv` resolves a destination that is a symlink **to a directory** and moves the source
# *into* it, so the new pointer landed inside the old release directory and `current` never moved.
# The installer printed "current -> releases/<new>" and exited 0 while the filesystem still said
# <old>. `-n` (--no-dereference) is precisely the flag that makes ln replace the symlink itself.
#
# What is given up is atomicity: `ln -sfn` unlinks and recreates, so a crash inside that window
# leaves no `current` at all. That is an acceptable trade here — the window is microseconds on a
# single-user workstation, and the launcher's own precondition check reports a missing `current` in
# plain language instead of failing obscurely. What is NOT acceptable is an unverified print, so each
# pointer is read back and a mismatch aborts the install.
printf '正在启用版本 %s…\n' "$RELEASE_ID"

set_pointer() {
  pointer="$1"
  release="$2"
  ln -sfn "releases/$release" "$pointer"
  actual="$(readlink "$pointer" 2>/dev/null || true)"
  [ "$actual" = "releases/$release" ] \
    || die "启用失败：$pointer 实际指向「${actual:-（无）}」，期望「releases/$release」。原有版本未受影响。"
}

if [ -n "$OLD_ID" ] && [ "$OLD_ID" != "$RELEASE_ID" ]; then
  set_pointer "$PREVIOUS" "$OLD_ID"
  printf '  上一版本记录为：%s（已核对）\n' "$OLD_ID"
fi
set_pointer "$CURRENT" "$RELEASE_ID"
printf '  current -> releases/%s（已核对）\n\n' "$RELEASE_ID"

# ---------------------------------------------------------------- 7. desktop entry
#
# Two absolute paths are substituted into the template, and both are absolute on purpose:
#
#   Exec  — a desktop session does not necessarily have ~/.local/bin on PATH, and a menu entry has no
#           working directory to depend on;
#   Icon  — pointed through `current`, so the icon follows the active release without being rewritten
#           on every upgrade.
#
# The browser is deliberately NOT named. The launcher goes through xdg-open, i.e. the desktop's own
# default association, which on the tested target resolves to com.360.browser-stable.desktop. Invoking
# the 360 binary directly would risk a different browser profile, and the business data belongs to a
# profile — so it would present as an empty application.
#
# The rationale lives here rather than in the template because sed rewrites the template: an earlier
# version explained the placeholders *inside* the file, and the placeholders in that explanation were
# substituted too, so the installed entry asserted that two absolute paths "are substituted by
# install.sh". Caught by reading the generated file, not the template.
printf '正在安装菜单项…\n'
DESKTOP_SRC="$TARGET/runtime/civic-work-desk.desktop"
[ -f "$DESKTOP_SRC" ] || die "安装包缺少 runtime/civic-work-desk.desktop。"
DESKTOP_TMP="$DESKTOP_DIR/.civic-work-desk.desktop.new"
sed -e "s|@@BIN@@|$BIN|g" -e "s|@@PREFIX@@|$PREFIX|g" "$DESKTOP_SRC" >"$DESKTOP_TMP"

# A surviving placeholder is a silent failure from the menu: the user clicks the icon and absolutely
# nothing happens, with no error anywhere. So it is checked rather than assumed.
if grep -q '@@' "$DESKTOP_TMP"; then
  rm -f "$DESKTOP_TMP"
  die "菜单项模板中仍有未替换的占位符，已中止。"
fi
grep -q "^Exec=$BIN/civic-work-desk\$" "$DESKTOP_TMP" \
  || { rm -f "$DESKTOP_TMP"; die "菜单项的 Exec 行不正确，已中止。"; }
mv -f "$DESKTOP_TMP" "$DESKTOP_FILE"
chmod 644 "$DESKTOP_FILE"
printf '  %s\n' "$DESKTOP_FILE"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
  printf '  已刷新菜单数据库。\n'
fi
printf '\n'

# ---------------------------------------------------------------- 8. prune old releases
#
# Current and previous are kept; anything older is removed, and each removal is printed. Silent
# housekeeping is how a directory quietly stops containing what someone expects it to contain.
KEEP_PREV=""
if [ -L "$PREVIOUS" ]; then
  KEEP_PREV="$(basename "$(readlink "$PREVIOUS" 2>/dev/null || echo '')" 2>/dev/null || true)"
fi
for dir in "$RELEASES"/*; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  if [ "$id" = "$RELEASE_ID" ] || [ "$id" = "$KEEP_PREV" ]; then
    continue
  fi
  rm -rf "$dir"
  printf '已清理旧版本目录：%s\n' "$id"
done

# ---------------------------------------------------------------- 9. PATH advice
case ":${PATH:-}:" in
  *":$BIN:"*) ;;
  *)
    printf '提示：%s 不在 PATH 中。\n' "$BIN"
    printf '      从开始菜单启动不受影响（菜单项使用绝对路径）。\n'
    printf '      若希望在终端里直接使用这些命令，请把下面一行加入 ~/.bashrc：\n'
    printf '          export PATH="$HOME/.local/bin:$PATH"\n'
    printf '      本安装程序不会替你修改 shell 配置文件。\n\n'
    ;;
esac

# ---------------------------------------------------------------- 10. verify by starting
printf '======================================================\n'
printf '安装完成：%s\n' "$RELEASE_ID"
printf '地址：    http://127.0.0.1:8765/\n'
printf '\n'

if [ "$START_AFTER" != yes ]; then
  printf '（按要求未启动本地服务。）\n'
  printf '下一步：从开始菜单打开「政务工作记录台」。\n'
  exit 0
fi

printf '正在启动并检查…\n'
if "$BIN/civic-work-desk" --no-browser; then
  printf '\n检查通过。下一步：从开始菜单打开「政务工作记录台」。\n'
else
  printf '\n警告：启动检查未通过。请运行 civic-work-desk-status 查看详情。\n' >&2
  exit 1
fi

if [ "$SERVER_WAS_RUNNING" = yes ]; then
  printf '\n如果浏览器还开着旧版本：页面顶部会出现「有新版本可用」，点「应用更新」即可；\n'
  printf '也可以关闭标签页后从菜单重新打开。不需要清除浏览器数据。\n'
fi
