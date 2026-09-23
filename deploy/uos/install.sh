#!/bin/sh
# CivicWorkDesk — 安装 / 升级（用户级，不需要 sudo）
#
#   sh install.sh              安装或升级到本包所含的版本
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
# It never uses sudo, never writes a system path, never installs a package, never registers a service,
# never modifies a system-wide MIME or browser association, and never reads or writes the 360 browser
# profile. The business data is in that browser and is untouched by installing, upgrading, rolling
# back or uninstalling.
#
# ## Stage, verify, then activate — in that order
#
# The ordering is the safety property, and an earlier version got it wrong in two ways worth naming:
# it stopped the running server before copying anything, and with `--force` it deleted the existing
# release directory before the replacement had been written. Either way, a failure part-way through —
# a short write, a full disk, a corrupt bundle — left no working installation, while the comments
# claimed the previous release would keep running.
#
# So now:
#
#   1. verify the bundle against its own manifest before executing any of its code;
#   2. stage the new release into a CivicWorkDesk-owned temporary directory, touching nothing that is
#      in use, and with the existing server left running;
#   3. verify the staged copy;
#   4. only then enter a short activation phase: rename the staging directory into place, install the
#      commands, and move the pointers with read-back;
#   5. restart and health-check.
#
# Any failure before step 4 leaves the active release and the running service exactly as they were.
#
# ## There is no --force
#
# It used to exist and it was destructive: same release id meant "delete the installed directory, then
# copy". Refusing is better. A same-id reinstall now either resumes an incomplete activation (safe,
# because the directory is re-verified first) or stops and tells the operator what to do. See
# docs/uos-upgrade-recovery.md.

set -eu

BUNDLE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"

START_AFTER=yes
for arg in "$@"; do
  case "$arg" in
    --no-start) START_AFTER=no ;;
    --force)
      printf '错误：--force 已被移除。\n' >&2
      printf '\n' >&2
      printf '它的做法是先删除已安装的版本目录再复制，中途失败就什么都不剩了。\n' >&2
      printf '现在的办法：\n' >&2
      printf '  · 要装新版本 —— 用一个新的版本号重新出包；\n' >&2
      printf '  · 当前版本的文件损坏了 —— 见 docs/uos-upgrade-recovery.md 的「修复」一节。\n' >&2
      exit 1
      ;;
    -h | --help)
      printf '用法：sh install.sh [--no-start]\n'
      printf '  安装或升级到本包所含的版本。不需要 sudo。\n'
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

[ -f "$BUNDLE_DIR/VERSION" ] || die "安装包不完整：缺少 VERSION。"
[ -f "$BUNDLE_DIR/SHA256SUMS.txt" ] || die "安装包不完整：缺少 SHA256SUMS.txt。"
[ -d "$BUNDLE_DIR/app" ] || die "安装包不完整：缺少 app 目录。"
[ -f "$BUNDLE_DIR/app/index.html" ] || die "安装包不完整：缺少 app/index.html。"
[ -d "$BUNDLE_DIR/runtime" ] || die "安装包不完整：缺少 runtime 目录。"
[ -f "$BUNDLE_DIR/runtime/civic-lib.sh" ] || die "安装包不完整：缺少 runtime/civic-lib.sh。"

command -v busybox >/dev/null 2>&1 \
  || die "本机未找到 busybox，无法运行本程序。请联系交付方。"
busybox --list 2>/dev/null | grep -qx httpd \
  || die "本机的 busybox 未包含 httpd 组件，无法运行本程序。请联系交付方。"

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
  */* | *..* | .* | *' '*) die "releaseId 含有非法字符：$RELEASE_ID" ;;
esac

printf '安装包版本：%s\n' "$RELEASE_ID"
printf '校验工具：  %s\n\n' "$SHA_TOOL"

# ---------------------------------------------------------------- 2. verify the bundle
#
# Before anything is copied, and before any of the bundle's own shell code is sourced. Executing code
# out of a bundle that has not been checked would make the check decorative.
printf '正在校验安装包…\n'
MANIFEST_LINES="$(grep -c '' "$BUNDLE_DIR/SHA256SUMS.txt")"
( cd "$BUNDLE_DIR" && $SHA_TOOL -c SHA256SUMS.txt >/dev/null 2>&1 ) \
  || die "安装包校验失败，文件可能在传输中损坏。请重新获取安装包，不要继续安装。"
printf '  通过：%s 个文件与清单一致。\n\n' "$MANIFEST_LINES"

# ---------------------------------------------------------------- 3. load the verified library
# shellcheck source=/dev/null
. "$BUNDLE_DIR/runtime/civic-lib.sh"

STAGING_ROOT="$CIVIC_PREFIX/.staging"
STAGE=""

cleanup_stage() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
    rm -rf "$STAGE"
  fi
}
trap cleanup_stage EXIT INT TERM

TARGET="$CIVIC_RELEASES/$RELEASE_ID"

# Verify a release directory against the copy of the manifest it carries. Only the members that a
# release directory actually holds are checked — install.sh and the README stay in the bundle.
verify_release_dir() {
  dir="$1"
  [ -f "$dir/SHA256SUMS.txt" ] || return 1
  filtered="$dir/.verify-manifest.$$"
  grep -E '^[0-9a-f]{64}[ ]+[*]?(app/|runtime/|VERSION$)' "$dir/SHA256SUMS.txt" >"$filtered" 2>/dev/null \
    || { rm -f "$filtered"; return 1; }
  count="$(grep -c '' "$filtered")"
  if [ "$count" -eq 0 ]; then
    rm -f "$filtered"
    return 1
  fi
  if ( cd "$dir" && $SHA_TOOL -c ".verify-manifest.$$" >/dev/null 2>&1 ); then
    rm -f "$filtered"
    printf '%s\n' "$count"
    return 0
  fi
  rm -f "$filtered"
  return 1
}

# ---------------------------------------------------------------- 4. what kind of run is this
OLD_ID="$(civic_active_release)"
MODE=install

if [ -n "$OLD_ID" ]; then
  printf '检测到已安装版本：%s\n' "$OLD_ID"
else
  printf '未检测到已安装版本，将进行首次安装。\n'
fi

if [ -d "$TARGET" ]; then
  if [ "$OLD_ID" = "$RELEASE_ID" ]; then
    printf '\n当前已经是这个版本，且已启用。\n'
    printf '安装程序不会重复覆盖同一版本的文件——那需要先删除正在使用的目录，\n'
    printf '中途失败就没有可用版本了。\n\n'
    printf '如果要装新版本：请用一个新的版本号重新出包。\n'
    printf '如果怀疑当前版本的文件损坏：先运行\n'
    printf '    %s/civic-work-desk-status\n' "$CIVIC_BIN"
    printf '再看 docs/uos-upgrade-recovery.md 的「修复」一节。\n'
    exit 0
  fi

  # The directory exists but is not the active release: an earlier run was interrupted between
  # staging and activation. Re-verify it and finish the job rather than refusing — the verification
  # is what makes resuming safe.
  printf '\n发现同版本目录已存在，但当前启用的不是它（可能是上次安装中断）。\n'
  printf '正在校验该目录…\n'
  if RESUME_COUNT="$(verify_release_dir "$TARGET")"; then
    printf '  通过：%s 个文件。将直接续做启用步骤，不重新复制。\n' "$RESUME_COUNT"
    MODE=resume
  else
    printf '\n' >&2
    printf '错误：该目录校验失败，内容不完整或已损坏：\n' >&2
    printf '    %s\n' "$TARGET" >&2
    printf '\n' >&2
    printf '为避免启用一个不完整的版本，安装已停止，当前使用的版本未受影响。\n' >&2
    printf '处理办法（二选一）：\n' >&2
    printf '  1. 用一个新的版本号重新出包并安装；\n' >&2
    printf '  2. 确认无误后手工删除上面这个目录，再重新运行本安装程序。\n' >&2
    exit 1
  fi
fi
printf '\n'

# ---------------------------------------------------------------- 5. stage (nothing in use is touched)
if [ "$MODE" = install ]; then
  printf '正在准备新版本（暂存，不影响正在使用的版本）…\n'
  mkdir -p "$STAGING_ROOT" "$CIVIC_RELEASES" \
    || die "无法创建暂存目录：$STAGING_ROOT"
  STAGE="$STAGING_ROOT/$RELEASE_ID.$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/app" "$STAGE/runtime" \
    || die "无法创建暂存目录：$STAGE（磁盘是否已满？）当前版本未受影响。"

  cp -R "$BUNDLE_DIR/app/." "$STAGE/app/" \
    || die "复制程序文件失败（磁盘是否已满？）。已放弃本次安装，当前版本未受影响。"
  cp -R "$BUNDLE_DIR/runtime/." "$STAGE/runtime/" \
    || die "复制运行文件失败。已放弃本次安装，当前版本未受影响。"
  cp "$BUNDLE_DIR/VERSION" "$STAGE/VERSION" \
    || die "复制 VERSION 失败。已放弃本次安装，当前版本未受影响。"
  cp "$BUNDLE_DIR/SHA256SUMS.txt" "$STAGE/SHA256SUMS.txt" \
    || die "复制清单失败。已放弃本次安装，当前版本未受影响。"

  # Verify the copy, not just the source. A short read or a full disk produces a truncated file that
  # the source-side check cannot see.
  printf '正在校验暂存的文件…\n'
  if STAGED_COUNT="$(verify_release_dir "$STAGE")"; then
    printf '  通过：%s 个文件。\n\n' "$STAGED_COUNT"
  else
    die "暂存文件校验失败。已放弃本次安装，当前版本与正在运行的服务都未受影响。"
  fi
fi

# ---------------------------------------------------------------- 6. activation
#
# Short, and ordered so that the release only becomes active once everything it needs is in place.
# Renaming the staging directory is a same-filesystem rename, so the release directory appears
# complete or not at all.
printf '正在启用版本 %s…\n' "$RELEASE_ID"

if [ "$MODE" = install ]; then
  mv "$STAGE" "$TARGET" || die "启用失败：无法就位。当前版本未受影响。"
  STAGE=""
  [ -d "$TARGET/app" ] || die "启用失败：就位后目录不完整。当前版本未受影响。"
fi

mkdir -p "$CIVIC_LIBDIR" "$CIVIC_BIN" "$CIVIC_DESKTOP_DIR" "$CIVIC_LOGDIR"

COMMANDS="civic-work-desk civic-work-desk-status civic-work-desk-stop civic-work-desk-rollback civic-work-desk-uninstall"

cp "$TARGET/runtime/civic-lib.sh" "$CIVIC_LIBDIR/civic-lib.sh" \
  || die "安装运行库失败。当前启用的版本尚未改变。"
chmod 644 "$CIVIC_LIBDIR/civic-lib.sh"
for name in $COMMANDS; do
  [ -f "$TARGET/runtime/$name.sh" ] || die "安装包缺少 runtime/$name.sh。"
  cp "$TARGET/runtime/$name.sh" "$CIVIC_BIN/$name" \
    || die "安装命令 $name 失败。当前启用的版本尚未改变。"
  chmod 755 "$CIVIC_BIN/$name"
done
printf '  已安装 5 个命令到 %s\n' "$CIVIC_BIN"

# Pointers last, each read back. `previous` before `current`, so that if the second one fails the
# worst state is both pointing at the old release — which is exactly the state we started in.
if [ -n "$OLD_ID" ] && [ "$OLD_ID" != "$RELEASE_ID" ]; then
  RESULT="$(civic_set_pointer "$CIVIC_PREVIOUS" "$OLD_ID" || true)"
  case "$RESULT" in
    ok:*) printf '  上一版本记录为：%s（已核对）\n' "$OLD_ID" ;;
    *) die "无法记录上一版本（$RESULT）。当前启用的版本未改变。" ;;
  esac
fi

RESULT="$(civic_set_pointer "$CIVIC_CURRENT" "$RELEASE_ID" || true)"
case "$RESULT" in
  ok:*)
    printf '  current -> releases/%s（已核对，%s）\n\n' "$RELEASE_ID" "${RESULT#ok:}"
    ;;
  *)
    printf '\n' >&2
    printf '错误：切换版本指针失败（%s）。\n' "$RESULT" >&2
    printf '新版本的文件已就位，但没有启用；原版本仍然是启用状态。\n' >&2
    printf '重新运行本安装程序会续做启用步骤。\n' >&2
    exit 1
    ;;
esac

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
#
# This runs AFTER activation, so a failure here cannot prevent the release being usable. It is still
# reported as a failure, because an application with no menu entry is not installed as far as the user
# is concerned — and re-running the installer retries it through the resume path.
printf '正在安装菜单项…\n'
DESKTOP_SRC="$TARGET/runtime/civic-work-desk.desktop"
[ -f "$DESKTOP_SRC" ] || die "安装包缺少 runtime/civic-work-desk.desktop。"
DESKTOP_TMP="$CIVIC_DESKTOP_DIR/.civic-work-desk.desktop.new"
DESKTOP_OK=yes
if ! sed -e "s|@@BIN@@|$CIVIC_BIN|g" -e "s|@@PREFIX@@|$CIVIC_PREFIX|g" "$DESKTOP_SRC" \
  >"$DESKTOP_TMP" 2>/dev/null; then
  DESKTOP_OK=no
fi

if [ "$DESKTOP_OK" = yes ]; then
  # A surviving placeholder is a silent failure from the menu: the user clicks the icon and absolutely
  # nothing happens, with no error anywhere. So it is checked rather than assumed.
  if grep -q '@@' "$DESKTOP_TMP" 2>/dev/null; then
    DESKTOP_OK=no
  elif ! grep -q "^Exec=$CIVIC_BIN/civic-work-desk\$" "$DESKTOP_TMP" 2>/dev/null; then
    DESKTOP_OK=no
  elif ! mv -f "$DESKTOP_TMP" "$CIVIC_DESKTOP_FILE" 2>/dev/null; then
    DESKTOP_OK=no
  fi
fi

if [ "$DESKTOP_OK" = yes ]; then
  chmod 644 "$CIVIC_DESKTOP_FILE"
  printf '  %s\n' "$CIVIC_DESKTOP_FILE"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$CIVIC_DESKTOP_DIR" 2>/dev/null || true
    printf '  已刷新菜单数据库。\n'
  fi
else
  rm -f "$DESKTOP_TMP"
  printf '\n' >&2
  printf '错误：菜单项安装失败（目录是否不可写？）：\n' >&2
  printf '    %s\n' "$CIVIC_DESKTOP_FILE" >&2
  printf '\n' >&2
  printf '版本 %s 已经启用，可以用命令启动：\n' "$RELEASE_ID" >&2
  printf '    %s/civic-work-desk\n' "$CIVIC_BIN" >&2
  printf '解决目录权限后重新运行本安装程序即可补上菜单项。\n' >&2
  exit 1
fi
printf '\n'

# ---------------------------------------------------------------- 8. prune old releases
#
# Current and previous are kept; anything older is removed, and each removal is printed. Silent
# housekeeping is how a directory quietly stops containing what someone expects it to contain.
KEEP_PREV="$(civic_previous_release)"
for dir in "$CIVIC_RELEASES"/*; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  if [ "$id" = "$RELEASE_ID" ] || [ "$id" = "$KEEP_PREV" ]; then
    continue
  fi
  rm -rf "$dir"
  printf '已清理旧版本目录：%s\n' "$id"
done
if [ -d "$STAGING_ROOT" ]; then
  rmdir "$STAGING_ROOT" 2>/dev/null || true
fi

# ---------------------------------------------------------------- 9. PATH advice
case ":${PATH:-}:" in
  *":$CIVIC_BIN:"*) ;;
  *)
    printf '提示：%s 不在 PATH 中。\n' "$CIVIC_BIN"
    printf '      从开始菜单启动不受影响（菜单项使用绝对路径）。\n'
    printf '      若希望在终端里直接使用这些命令，请把下面一行加入 ~/.bashrc：\n'
    printf '          export PATH="$HOME/.local/bin:$PATH"\n'
    printf '      本安装程序不会替你修改 shell 配置文件。\n\n'
    ;;
esac

# ---------------------------------------------------------------- 10. restart and verify
#
# The running server resolved its document root at startup, so after a release switch it is still
# serving the previous directory and must be restarted. This is the only point at which the service is
# interrupted, and it is after the new release is fully in place.
printf '======================================================\n'
printf '安装完成：%s\n' "$RELEASE_ID"
printf '地址：    http://127.0.0.1:8765/\n\n'

WAS_RUNNING=no
RUNNING_PID="$(civic_server_pid)"
if [ -n "$RUNNING_PID" ]; then
  WAS_RUNNING=yes
  printf '正在重启本地服务（原 PID %s，它仍在提供旧版本）…\n' "$RUNNING_PID"
  set +e
  civic_server_stop >/dev/null
  STOP_RC=$?
  set -e
  # Status 2 means the library declined to force-kill a PID that stopped being ours, so something may
  # still hold the port. Say that here rather than letting the next step surface it as a puzzling
  # "the port is occupied by another process" — the new release is already installed and active.
  if [ "$STOP_RC" = 2 ]; then
    printf '\n' >&2
    printf '注意：停止旧服务时中止了（原因见上方），端口 %s 可能仍被占用。\n' "$CIVIC_PORT" >&2
    printf '版本 %s 已经启用。请先确认端口占用情况，再运行：\n' "$RELEASE_ID" >&2
    printf '    %s/civic-work-desk\n' "$CIVIC_BIN" >&2
    exit 1
  fi
fi

if [ "$START_AFTER" != yes ]; then
  printf '（按要求未启动本地服务。）\n'
  printf '下一步：从开始菜单打开「政务工作记录台」。\n'
  exit 0
fi

printf '正在启动并检查…\n'
if "$CIVIC_BIN/civic-work-desk" --no-browser; then
  printf '\n检查通过。下一步：从开始菜单打开「政务工作记录台」。\n'
else
  printf '\n' >&2
  printf '警告：启动检查未通过。新版本 %s 已启用。\n' "$RELEASE_ID" >&2
  printf '请依次尝试：\n' >&2
  printf '  1. %s/civic-work-desk-status   查看原因；\n' "$CIVIC_BIN" >&2
  if [ -n "$KEEP_PREV" ]; then
    printf '  2. %s/civic-work-desk-rollback  回退到 %s。\n' "$CIVIC_BIN" "$KEEP_PREV" >&2
  fi
  exit 1
fi

if [ "$WAS_RUNNING" = yes ]; then
  printf '\n如果浏览器还开着旧版本：页面顶部会出现「有新版本可用」，点「应用更新」即可；\n'
  printf '也可以关闭标签页后从菜单重新打开。不需要清除浏览器数据。\n'
fi
