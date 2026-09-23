#!/bin/sh
# Build the FINAL UOS end-user release candidate. Runs on the DEVELOPMENT machine.
#
#   sh scripts/uos/build-release.sh [release-id]
#
# Default release id is today's business date in UTC+8 plus a sequence suffix, e.g. 2026.09.23-1.
# The date is taken with TZ=UTC-8 rather than from the machine clock: this workstation runs on US
# Eastern, so a bare `date` can name yesterday.
#
# ## Two archives, on purpose
#
#   1. civic-work-desk-uos20-loongarch64-<id>.tar.gz
#      The end-user artifact. Contains only what installation and use require: the application, the
#      runtime, the installer, a README. No source tree, no tests, no acceptance paperwork.
#
#   2. civic-work-desk-uos20-final-acceptance-<id>.tar.gz
#      The tester's kit for the final installed-form physical validation: the manual, the result
#      template, the result collector and the port-conflict helper. Kept out of the user artifact so
#      that artifact stays clean, and shipped alongside it because the tester needs both.
#
# ## What this does NOT do
#
# It does not build the application. `dist/` must already be the output of a full gate run, and the
# application payload is verified byte-identical to it before anything is packaged — Phase 3 ships
# the Phase-2 build unchanged, and a convenience rebuild here would make it possible to package
# something no gate has seen.

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
SRC="$ROOT/deploy/uos"
STAGE_ROOT="$ROOT/release/uos20"

CANONICAL_ORIGIN="http://127.0.0.1:8765"
RELEASE_ID="${1:-$(TZ=UTC-8 date +%Y.%m.%d)-1}"

case "$RELEASE_ID" in
  */* | *..* | "") printf 'error: illegal release id: %s\n' "$RELEASE_ID" >&2; exit 2 ;;
esac

APP_NAME="civic-work-desk-uos20-loongarch64-$RELEASE_ID"
KIT_NAME="civic-work-desk-uos20-final-acceptance-$RELEASE_ID"
APP_STAGE="$STAGE_ROOT/$APP_NAME"
KIT_STAGE="$STAGE_ROOT/$KIT_NAME"
APP_ARCHIVE="$ROOT/release/$APP_NAME.tar.gz"
KIT_ARCHIVE="$ROOT/release/$KIT_NAME.tar.gz"

[ -d "$ROOT/dist" ] || {
  printf 'error: dist/ not found. Run `npm run review:package` (which builds and gates) first.\n' >&2
  exit 2
}
[ -f "$ROOT/dist/index.html" ] || {
  printf 'error: dist/index.html missing — the build is incomplete.\n' >&2
  exit 2
}
[ -d "$SRC/runtime" ] || { printf 'error: %s missing.\n' "$SRC/runtime" >&2; exit 2; }

APP_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
APP_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf 'Building UOS release candidate\n'
printf '  release id : %s\n' "$RELEASE_ID"
printf '  app version: %s\n' "$APP_VERSION"
printf '  app commit : %s\n' "$APP_COMMIT"
printf '  origin     : %s\n\n' "$CANONICAL_ORIGIN"

rm -rf "$APP_STAGE" "$KIT_STAGE"
mkdir -p "$APP_STAGE/app" "$APP_STAGE/runtime" "$KIT_STAGE"

# ---- application payload -----------------------------------------------------------------------
# Replaced wholesale rather than merged, so a file dropped from a later build cannot survive as a
# stale asset.
cp -R "$ROOT/dist/." "$APP_STAGE/app/"

ENTRY_JS="$(cd "$APP_STAGE/app" && ls assets/index-*.js 2>/dev/null | head -n 1 || true)"
ENTRY_CSS="$(cd "$APP_STAGE/app" && ls assets/index-*.css 2>/dev/null | head -n 1 || true)"
[ -n "$ENTRY_JS" ] || { printf 'error: no entry JS in dist/assets.\n' >&2; exit 2; }
[ -n "$ENTRY_CSS" ] || { printf 'error: no entry CSS in dist/assets.\n' >&2; exit 2; }

# The health asset is written beside the application rather than into it, which is what keeps the
# Phase-2 build unmodified. `releaseId` is what the launcher's health gate compares against the
# release the `current` pointer resolves to.
cat >"$APP_STAGE/app/deployment-health.json" <<JSON
{
  "application": "civic-work-desk",
  "releaseChannel": "uos20-loongarch64",
  "releaseId": "$RELEASE_ID",
  "appVersion": "$APP_VERSION",
  "canonicalOrigin": "$CANONICAL_ORIGIN",
  "applicationCommit": "$APP_COMMIT",
  "builtAt": "$BUILT_AT",
  "entry": { "js": "$ENTRY_JS", "css": "$ENTRY_CSS" },
  "note": "Deployment health probe. Contains no personal data and no secrets. The launcher fetches this to confirm the server at the canonical origin is serving the expected release before opening the browser."
}
JSON

# ---- prove the application payload is unchanged BEFORE packaging --------------------------------
printf 'Verifying the application payload against dist/…\n'
node "$ROOT/scripts/uos/verify-app-unchanged.mjs" "$APP_STAGE/app" --against "$ROOT/dist"
printf '\n'

# ---- runtime + installer -----------------------------------------------------------------------
for file in civic-lib.sh civic-work-desk.sh civic-work-desk-status.sh civic-work-desk-stop.sh \
  civic-work-desk-rollback.sh civic-work-desk-uninstall.sh httpd.conf civic-work-desk.desktop; do
  [ -f "$SRC/runtime/$file" ] || { printf 'error: missing %s\n' "$SRC/runtime/$file" >&2; exit 2; }
  cp "$SRC/runtime/$file" "$APP_STAGE/runtime/$file"
done
cp "$SRC/install.sh" "$APP_STAGE/install.sh"
# ASCII filename, Chinese content. A non-ASCII path would otherwise cross several escape layers
# between here, tar and the target's shell for no benefit.
cp "$SRC/README.md" "$APP_STAGE/README.md"
chmod 755 "$APP_STAGE/install.sh"

# ---- VERSION -----------------------------------------------------------------------------------
#
# Two different facts, stated as two different fields, because collapsing them into one
# "validatedOn" line was too easy to read as a compatibility claim:
#
#   rc11ApplicationServingValidatedOn — what RC1.1 really established on the physical machine: this
#                                       application, served by BusyBox, in that browser;
#   installedFormTargetValidated      — whether the installer/launcher lifecycle in THIS artifact has
#                                       been validated there. It has not.
#
# `targetTested` stays NO until the second one is YES. It is a fact about this artifact, not a
# placeholder to tidy up later.
cat >"$APP_STAGE/VERSION" <<VERSION
CivicWorkDesk UOS release candidate
releaseId=$RELEASE_ID
appVersion=$APP_VERSION
applicationCommit=$APP_COMMIT
applicationPhase=Phase 2 build, unchanged
phase3Stage=Stage B.1 (final installed form — target validation pending)
canonicalOrigin=$CANONICAL_ORIGIN
server=busybox-httpd
serverSelectedBy=RC1.1 physical-target evidence (MIME, traversal, directory listing, app behaviour)
pythonRequired=NO
sudoRequired=NO
builtAt=$BUILT_AT
builtOn=development workstation, Node 24
rc11ApplicationServingValidatedOn=UOS Desktop 20 Professional / loongarch64 / Loongson 3A6000 / kernel 4.19.0-loongson-3-desktop / 360 Browser 13.4.1140.83 / Chromium 126.0.6478.251
installedFormTargetValidated=NO — the installer, launcher, upgrade, rollback and uninstall lifecycle in this artifact has not yet run on the physical workstation
genericPlatformSupportClaimed=NO — no claim is made for Linux, UOS or LoongArch in general
targetTested=NO — final installed form not yet validated on the physical workstation
VERSION

# ---- inner manifest ----------------------------------------------------------------------------
( cd "$APP_STAGE" \
  && rm -f SHA256SUMS.txt \
  && find . -type f ! -name 'SHA256SUMS.txt' \
    | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
        sha256sum "$file"
      done >SHA256SUMS.txt )
printf 'Inner manifest: %s files\n' "$(grep -c '' "$APP_STAGE/SHA256SUMS.txt")"

# ---- acceptance kit ----------------------------------------------------------------------------
mkdir -p "$KIT_STAGE/scripts"
cp "$SRC/acceptance/FINAL_ACCEPTANCE.md" "$KIT_STAGE/FINAL_ACCEPTANCE.md"
cp "$SRC/acceptance/RESULT_TEMPLATE.md" "$KIT_STAGE/RESULT_TEMPLATE.md"
cp "$SRC/acceptance/collect-results.sh" "$KIT_STAGE/scripts/collect-results.sh"
cp "$SRC/acceptance/port-conflict-test.sh" "$KIT_STAGE/scripts/port-conflict-test.sh"
cp "$SRC/acceptance/post-uninstall-check.sh" "$KIT_STAGE/scripts/post-uninstall-check.sh"
cat >"$KIT_STAGE/VERSION" <<KITVERSION
CivicWorkDesk UOS final-acceptance kit
kitFor=$APP_NAME
releaseId=$RELEASE_ID
builtAt=$BUILT_AT
purpose=physical validation of the FINAL installed form
KITVERSION
( cd "$KIT_STAGE" \
  && rm -f SHA256SUMS.txt \
  && find . -type f ! -name 'SHA256SUMS.txt' \
    | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
        sha256sum "$file"
      done >SHA256SUMS.txt )

# ---- archives ----------------------------------------------------------------------------------
#
# `--owner=0 --group=0 --numeric-owner` strips this machine's identity: a Windows account name and a
# Windows GID mean nothing on the target and need not travel. Numeric 0/0 does not require root to
# extract, because tar only applies ownership when it is running as root. Permissions are left as
# they are on disk, which preserves the executable bit on install.sh.
cd "$STAGE_ROOT"
rm -f "$APP_ARCHIVE" "$APP_ARCHIVE.sha256" "$KIT_ARCHIVE" "$KIT_ARCHIVE.sha256"
tar --owner=0 --group=0 --numeric-owner -czf "$APP_ARCHIVE" "$APP_NAME"
tar --owner=0 --group=0 --numeric-owner -czf "$KIT_ARCHIVE" "$KIT_NAME"

( cd "$ROOT/release" && sha256sum "$APP_NAME.tar.gz" >"$APP_ARCHIVE.sha256" )
( cd "$ROOT/release" && sha256sum "$KIT_NAME.tar.gz" >"$KIT_ARCHIVE.sha256" )

# ---- report ------------------------------------------------------------------------------------
printf '\n===== end-user artifact =====\n'
printf 'Archive : %s\n' "$APP_ARCHIVE"
printf 'Bytes   : %s\n' "$(stat -c%s "$APP_ARCHIVE" 2>/dev/null || wc -c <"$APP_ARCHIVE")"
printf 'Entries : %s\n' "$(tar -tzf "$APP_ARCHIVE" | grep -c '')"
printf 'SHA-256 : %s\n' "$(cut -d' ' -f1 <"$APP_ARCHIVE.sha256")"

printf '\n===== final-acceptance kit =====\n'
printf 'Archive : %s\n' "$KIT_ARCHIVE"
printf 'Bytes   : %s\n' "$(stat -c%s "$KIT_ARCHIVE" 2>/dev/null || wc -c <"$KIT_ARCHIVE")"
printf 'SHA-256 : %s\n' "$(cut -d' ' -f1 <"$KIT_ARCHIVE.sha256")"

printf '\nOwnership metadata (first 3 entries of the end-user artifact):\n'
tar -tvzf "$APP_ARCHIVE" | head -n 3 | sed 's/^/    /'
printf '\nExecutable bits:\n'
tar -tvzf "$APP_ARCHIVE" | grep -E 'install\.sh$' | sed 's/^/    /'

printf '\nReminder: targetTested=NO. Phase 3 is not complete until the FINAL installed form has been\n'
printf 'validated on the physical UOS workstation.\n'
