#!/bin/sh
# CivicWorkDesk — 安装 / 升级 / 修复（用户级，不需要 sudo）
#
#   sh install.sh              安装、升级，或修复同版本的部署集成
#   sh install.sh --no-start   完成后不启动本地服务
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
# profile. The business data is in that browser and is untouched by installing, upgrading, repairing,
# rolling back or uninstalling.
#
# ## Stage, verify, then activate — in that order
#
#   1. verify the bundle against its own manifest before executing any of its code;
#   2. take the installer lock, so two installers cannot both decide to stage;
#   3. stage the new release into a CivicWorkDesk-owned temporary directory, touching nothing that is
#      in use, and with the existing server left running;
#   4. verify the staged copy;
#   5. only then a short activation phase: a destination-safe rename into place, the commands, and the
#      pointers with read-back;
#   6. restart and health-check.
#
# Any failure before step 5 leaves the active release and the running service exactly as they were.
# A failure *after* activation — the desktop entry or the restart — is reported as a failure with the
# release already usable, and re-running this same package repairs it. That is the honest description:
# it is not all-or-nothing, and the README says so in the same words.
#
# ## Three modes
#
#   install  a release id that is not present          -> stage, verify, activate
#   resume   present but not active (interrupted run)  -> re-verify, then activate
#   repair   present and active                        -> re-verify, then reinstate the deployment
#            integration only (library, commands, menu entry). Never re-copies the app tree.
#
# There is no --force. It used to delete the installed release before the replacement existed, which
# made the guarantees above untrue. Refusing, resuming and repairing cover what it was used for.

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
      printf '  · 菜单项、命令之类的集成丢了 —— 直接重新运行本安装程序，它会自行修复；\n' >&2
      printf '  · 当前版本的程序文件损坏了 —— 见本包内 README.md 的「修复」一节。\n' >&2
      exit 1
      ;;
    -h | --help)
      printf '用法：sh install.sh [--no-start]\n'
      printf '  安装、升级，或修复同版本的部署集成。不需要 sudo。\n'
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
LOCK="$CIVIC_PREFIX/.install.lock"
HOLD_LOCK=no
FILTERED=""

cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
    rm -rf "$STAGE"
  fi
  [ -n "$FILTERED" ] && rm -f "$FILTERED"
  # Release only our own lock. If something else holds it by now, leaving it alone is strictly better
  # than removing a lock we do not own.
  if [ "$HOLD_LOCK" = yes ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$LOCK"
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- 4. installer lock
#
# Two installers run at once must not both decide to stage. Without this, both saw `$TARGET` absent,
# both staged, and the second one's `mv` landed its staging directory *inside* the first one's release
# — while every command reported success and the app check still passed. Reproduced against the
# delivered bytes; see the release-dir rename below for the second, independent guard.
#
# Same primitive as the launcher lock: a symlink whose target IS the holder's PID. One atomic
# operation takes the lock and records who holds it, so the lock can never exist without a holder.
# A holder that is alive and is an installer is respected; anything else is abandoned and broken, after
# re-reading the holder to be sure it is still the same one.
mkdir -p "$CIVIC_PREFIX" || die "无法创建安装目录：$CIVIC_PREFIX"
command -v ln >/dev/null 2>&1 || die "本机缺少 ln 命令，无法取得安装锁。请联系交付方。"

holder_is_live_installer() {
  candidate="$1"
  case "$candidate" in
    '' | *[!0-9]*) return 1 ;;
  esac
  kill -0 "$candidate" 2>/dev/null || return 1
  case "$(civic_pid_cmdline "$candidate")" in
    *install.sh*) return 0 ;;
    *) return 1 ;;
  esac
}

lock_wait=0
while [ "$lock_wait" -lt 30 ]; do
  if ln -s "$$" "$LOCK" 2>/dev/null; then
    HOLD_LOCK=yes
    break
  fi
  holder="$(readlink "$LOCK" 2>/dev/null || true)"
  if [ -z "$holder" ]; then
    lock_wait=$((lock_wait + 1))
    continue
  fi
  if holder_is_live_installer "$holder"; then
    [ "$lock_wait" -eq 0 ] && printf '另一个安装程序正在运行（PID %s），等待它结束…\n' "$holder"
    sleep 1
    lock_wait=$((lock_wait + 1))
    continue
  fi
  if [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$holder" ]; then
    printf '清理上次中断留下的安装锁（PID %s 已不存在）。\n' "$holder"
    rm -f "$LOCK"
  fi
  lock_wait=$((lock_wait + 1))
done

if [ "$HOLD_LOCK" != yes ]; then
  printf '错误：另一个安装程序仍在运行，本次没有做任何改动。\n' >&2
  printf '请等它结束后重试。如果确认没有别的安装在跑，可删除：\n' >&2
  printf '    %s\n' "$LOCK" >&2
  exit 1
fi

TARGET="$CIVIC_RELEASES/$RELEASE_ID"

# Verify a release directory against a manifest. The filtered manifest is written OUTSIDE the directory
# being checked, so verifying does not require that directory to be writable and never adds a file to
# a release tree.
#
# `$2` chooses what it is verified against: the copy of the manifest the directory carries, or this
# package's manifest. For repair the second is the question that matters — are the installed bytes the
# ones this package ships?
verify_release_dir() {
  dir="$1"
  manifest="$2"
  [ -f "$manifest" ] || return 1
  FILTERED="$CIVIC_PREFIX/.verify-manifest.$$"
  rm -f "$FILTERED"
  grep -E '^[0-9a-f]{64}[ ]+[*]?(app/|runtime/|VERSION$)' "$manifest" >"$FILTERED" 2>/dev/null \
    || { rm -f "$FILTERED"; FILTERED=""; return 1; }
  count="$(grep -c '' "$FILTERED")"
  if [ "$count" -eq 0 ]; then
    rm -f "$FILTERED"
    FILTERED=""
    return 1
  fi
  if ( cd "$dir" && $SHA_TOOL -c "$FILTERED" >/dev/null 2>&1 ); then
    rm -f "$FILTERED"
    FILTERED=""
    printf '%s\n' "$count"
    return 0
  fi
  rm -f "$FILTERED"
  FILTERED=""
  return 1
}

# A release directory holds exactly these four entries. Anything else means something was moved or
# written where it should not have been — the nested `<release-id>.<pid>` staging directory the
# concurrency defect produced is exactly this shape, and it is invisible to a manifest check because
# every listed file is still correct.
assert_release_shape() {
  dir="$1"
  unexpected=""
  for entry in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in
      app | runtime | VERSION | SHA256SUMS.txt) ;;
      *) unexpected="$unexpected $(basename "$entry")" ;;
    esac
  done
  if [ -n "$unexpected" ]; then
    printf '错误：版本目录内出现了不该有的内容：%s\n' "$unexpected" >&2
    printf '目录：%s\n' "$dir" >&2
    printf '这通常意味着有两个安装程序同时在跑。请检查该目录后重试。\n' >&2
    return 1
  fi
  return 0
}

cannot_repair_payload() {
  printf '\n' >&2
  printf '错误：当前启用版本 %s 的程序文件与本安装包不一致。\n' "$RELEASE_ID" >&2
  printf '目录：%s\n' "$TARGET" >&2
  printf '\n' >&2
  printf '安装程序不会就地覆盖正在使用的版本目录——那需要先删除它，中途失败就没有可用版本了。\n' >&2
  printf '可选的恢复办法（见本包内 README.md 的「修复」一节）：\n' >&2
  printf '  1. 用一个新的版本号重新出包并安装（推荐，全程不动这个目录）；\n' >&2
  printf '  2. 回退到上一个版本：%s/civic-work-desk-rollback；\n' "$CIVIC_BIN" >&2
  printf '  3. 确认无误后手工删除上面那个目录，再重新运行本安装程序。\n' >&2
}

# ---------------------------------------------------------------- 5. what kind of run is this
OLD_ID="$(civic_active_release)"
MODE=install

if [ -n "$OLD_ID" ]; then
  printf '检测到已安装版本：%s\n' "$OLD_ID"
else
  printf '未检测到已安装版本，将进行首次安装。\n'
fi

if [ -d "$TARGET" ]; then
  if [ "$OLD_ID" = "$RELEASE_ID" ]; then
    # Same release, already active. This is NOT a no-op: the deployment integration — the shared
    # library, the five commands, the menu entry — can be missing or damaged while the release itself
    # is perfectly fine, and the installer's own failure messages promise that re-running repairs it.
    # It used to exit 0 here and repair nothing, which made those messages false.
    printf '\n当前已经是这个版本。正在核对程序文件…\n'
    if REPAIR_COUNT="$(verify_release_dir "$TARGET" "$BUNDLE_DIR/SHA256SUMS.txt")"; then
      printf '  通过：%s 个文件与本安装包一致。\n' "$REPAIR_COUNT"
      printf '  将只检查并修复部署集成（运行库、五个命令、菜单项），不改动程序文件。\n'
      MODE=repair
    else
      cannot_repair_payload
      exit 1
    fi
  else
    # Present but not active: an earlier run was interrupted between staging and activation.
    # Re-verify and finish the job rather than refusing — the verification is what makes resuming safe.
    printf '\n发现同版本目录已存在，但当前启用的不是它（可能是上次安装中断）。\n'
    printf '正在校验该目录…\n'
    if RESUME_COUNT="$(verify_release_dir "$TARGET" "$TARGET/SHA256SUMS.txt")"; then
      printf '  通过：%s 个文件。将直接续做启用步骤，不重新复制。\n' "$RESUME_COUNT"
      MODE=resume
    else
      printf '\n' >&2
      printf '错误：该目录校验失败，内容不完整或已损坏：\n' >&2
      printf '    %s\n' "$TARGET" >&2
      printf '\n' >&2
      printf '为避免启用一个不完整的版本，安装已停止，当前使用的版本未受影响。\n' >&2
      printf '处理办法见本包内 README.md 的「修复」一节。\n' >&2
      exit 1
    fi
  fi
fi
printf '\n'

# ---------------------------------------------------------------- 6. stage (nothing in use is touched)
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
  if STAGED_COUNT="$(verify_release_dir "$STAGE" "$STAGE/SHA256SUMS.txt")"; then
    printf '  通过：%s 个文件。\n\n' "$STAGED_COUNT"
  else
    die "暂存文件校验失败。已放弃本次安装，当前版本与正在运行的服务都未受影响。"
  fi
fi

# ---------------------------------------------------------------- 7. activation
printf '正在启用版本 %s…\n' "$RELEASE_ID"

# Move the staging directory into place with an operation that CANNOT descend into an existing
# destination.
#
# Plain `mv` was the concurrency defect: with `$TARGET` already a directory, GNU mv moves the source
# *inside* it and exits 0 — measured. `mv -T` refuses ("Directory not empty"), changes nothing and
# leaves the staging directory intact for inspection. That is the property this needs, and it holds
# independently of the installer lock, which is why both exist.
#
# Where mv has no `-T` (BusyBox rejects it outright, also measured), the name is claimed with `mkdir`,
# which is atomic and fails if it exists; the staged entries are then moved into that empty directory,
# where no destination exists and so nothing can nest. That path is not atomic as a whole and is only
# reached on a machine without GNU coreutils.
move_stage_into_place() {
  err="$CIVIC_PREFIX/.mv-err.$$"
  if mv -T "$STAGE" "$TARGET" 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -q 'invalid option' "$err" 2>/dev/null; then
    rm -f "$err"
    mkdir "$TARGET" 2>/dev/null || return 2
    for entry in app runtime VERSION SHA256SUMS.txt; do
      mv "$STAGE/$entry" "$TARGET/$entry" || return 1
    done
    rmdir "$STAGE" 2>/dev/null || true
    return 0
  fi
  rm -f "$err"
  return 2
}

if [ "$MODE" = install ]; then
  set +e
  move_stage_into_place
  MOVE_RC=$?
  set -e
  case "$MOVE_RC" in
    0)
      STAGE=""
      ;;
    2)
      # The destination appeared while we were staging — another installer, or a leftover. Re-inspect
      # it instead of merging into it or overwriting it.
      printf '  版本目录在暂存期间出现了，正在核对它…\n'
      if verify_release_dir "$TARGET" "$BUNDLE_DIR/SHA256SUMS.txt" >/dev/null; then
        printf '  它正是本安装包的版本，校验通过。改为续做启用步骤，不覆盖它。\n'
        rm -rf "$STAGE"
        STAGE=""
        MODE=resume
      else
        printf '\n' >&2
        printf '错误：版本目录已存在，但内容与本安装包不一致：\n' >&2
        printf '    %s\n' "$TARGET" >&2
        printf '本次没有改动它，也没有启用任何新版本。处理办法见本包内 README.md 的「修复」一节。\n' >&2
        exit 1
      fi
      ;;
    *)
      die "启用失败：无法就位。当前版本未受影响。"
      ;;
  esac
fi

[ -d "$TARGET/app" ] || die "启用失败：版本目录不完整。当前版本未受影响。"
assert_release_shape "$TARGET" || exit 1

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

# Pointers, each read back. `previous` before `current`, so that if the second one fails the worst
# state is both pointing at the old release — which is exactly the state we started in. In repair mode
# the release is not changing, so only `current` is re-asserted, for its read-back.
if [ "$MODE" != repair ] && [ -n "$OLD_ID" ] && [ "$OLD_ID" != "$RELEASE_ID" ]; then
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

# ---------------------------------------------------------------- 8. desktop entry
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
# This runs AFTER activation, so a failure cannot prevent the release being usable. It is still a
# failure, because an application with no menu entry is not installed as far as the user is concerned —
# and re-running this package repairs it, which is now true rather than merely promised.
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

# ---------------------------------------------------------------- 9. verify the integration
#
# Return 0 only if the state the operator asked for is actually there. A repair run that reported
# success without restoring the menu entry is precisely the defect this section closes.
printf '正在核对部署集成…\n'
INTEGRATION_OK=yes
[ -r "$CIVIC_LIBDIR/civic-lib.sh" ] || INTEGRATION_OK=no
for name in $COMMANDS; do
  [ -x "$CIVIC_BIN/$name" ] || INTEGRATION_OK=no
done
[ -f "$CIVIC_DESKTOP_FILE" ] || INTEGRATION_OK=no
grep -q "^Exec=$CIVIC_BIN/civic-work-desk\$" "$CIVIC_DESKTOP_FILE" 2>/dev/null || INTEGRATION_OK=no
[ "$(readlink "$CIVIC_CURRENT" 2>/dev/null || true)" = "releases/$RELEASE_ID" ] || INTEGRATION_OK=no

if [ "$INTEGRATION_OK" != yes ]; then
  printf '\n' >&2
  printf '错误：部署集成核对未通过。请检查下面这些，然后重新运行本安装程序：\n' >&2
  printf '  运行库：%s\n' "$CIVIC_LIBDIR/civic-lib.sh" >&2
  printf '  命令：  %s\n' "$CIVIC_BIN" >&2
  printf '  菜单项：%s\n' "$CIVIC_DESKTOP_FILE" >&2
  printf '  版本指针：%s -> %s\n' "$CIVIC_CURRENT" \
    "$(readlink "$CIVIC_CURRENT" 2>/dev/null || echo '(无)')" >&2
  exit 1
fi
printf '  运行库、5 个命令、菜单项、版本指针，均已核对。\n\n'

# ---------------------------------------------------------------- 10. prune old releases
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

# ---------------------------------------------------------------- 11. PATH advice
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

# ---------------------------------------------------------------- 12. restart and verify
#
# The running server resolved its document root at startup, so after a release switch it is still
# serving the previous directory and must be restarted. This is the only point at which the service is
# interrupted, and it is after the new release is fully in place.
printf '======================================================\n'
case "$MODE" in
  repair) printf '修复完成：%s\n' "$RELEASE_ID" ;;
  resume) printf '启用完成：%s\n' "$RELEASE_ID" ;;
  *) printf '安装完成：%s\n' "$RELEASE_ID" ;;
esac
printf '地址：    http://127.0.0.1:8765/\n\n'

WAS_RUNNING=no
RUNNING_PID="$(civic_server_pid)"
if [ -n "$RUNNING_PID" ]; then
  WAS_RUNNING=yes
  printf '正在重启本地服务（原 PID %s）…\n' "$RUNNING_PID"
  set +e
  civic_server_stop >/dev/null
  STOP_RC=$?
  set -e
  # Status 2 means the library declined to force-kill a PID that stopped being ours, so something may
  # still hold the port. Say that here rather than letting the next step surface it as a puzzling
  # "the port is occupied by another process" — the release is already installed and active.
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
  printf '警告：启动检查未通过。版本 %s 已启用。\n' "$RELEASE_ID" >&2
  printf '请依次尝试：\n' >&2
  printf '  1. %s/civic-work-desk-status   查看原因；\n' "$CIVIC_BIN" >&2
  if [ -n "$KEEP_PREV" ]; then
    printf '  2. %s/civic-work-desk-rollback  回退到 %s。\n' "$CIVIC_BIN" "$KEEP_PREV" >&2
  fi
  exit 1
fi

if [ "$WAS_RUNNING" = yes ] && [ "$MODE" != repair ]; then
  printf '\n如果浏览器还开着旧版本：页面顶部会出现「有新版本可用」，点「应用更新」即可；\n'
  printf '也可以关闭标签页后从菜单重新打开。不需要清除浏览器数据。\n'
fi
