#!/bin/sh
# Package the UOS RC1.1 target-acceptance bundle. Runs on the DEVELOPMENT machine.
#
#   sh scripts/uos/build-rc1-1.sh
#
# ## What this deliberately does NOT do
#
# It does not touch `release/uos-rc1-1/app/`. RC1.1 corrects the acceptance harness only, and the
# application payload must stay byte-identical to RC1 and to the Phase-2 build — so there is no
# `cp dist/`, no rebuild, and no regeneration of `deployment-health.json` (re-stamping it would
# change a byte for no reason and break the very property being preserved).
#
# The proof is not left to this comment: `verify-app-unchanged.mjs` hashes every file on both sides
# and is run below, before anything is packaged.

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
BUNDLE="$ROOT/release/uos-rc1-1"
APP="$BUNDLE/app"
ARCHIVE="$ROOT/release/civic-work-desk-uos-rc1-1.tar.gz"
SIDECAR="$ARCHIVE.sha256"
RC1_ARCHIVE="$ROOT/release/civic-work-desk-uos-rc1.tar.gz"

CANONICAL_ORIGIN="http://127.0.0.1:8765"

[ -d "$APP" ] || {
  printf 'error: %s missing — RC1.1 does not create it, it inherits it.\n' "$APP" >&2
  exit 2
}
[ -f "$APP/index.html" ] || {
  printf 'error: app payload incomplete (no index.html).\n' >&2
  exit 2
}

# ---- prove the payload is unchanged BEFORE packaging ------------------------------------------
#
# Against `dist/` (the Phase-2 build) and, when it is still on disk, against the RC1 archive itself.
# Doing this first means a packaging run cannot produce an artifact whose payload was never checked.

printf 'Verifying the application payload is unchanged…\n'
REFERENCES="--against $ROOT/dist"
RC1_EXTRACT=""
if [ -f "$RC1_ARCHIVE" ]; then
  RC1_EXTRACT="$(mktemp -d 2>/dev/null || echo "$ROOT/release/.rc1-compare")"
  mkdir -p "$RC1_EXTRACT"
  # Removed on exit however this script ends, including on a failed comparison.
  trap 'rm -rf "$RC1_EXTRACT"' EXIT INT TERM
  tar -xzf "$RC1_ARCHIVE" -C "$RC1_EXTRACT"
  REFERENCES="$REFERENCES --against $RC1_EXTRACT/uos-rc1/app"
fi

# shellcheck disable=SC2086 # REFERENCES is a deliberate multi-token expansion
node "$ROOT/scripts/uos/verify-app-unchanged.mjs" "$APP" $REFERENCES

# ---- version -----------------------------------------------------------------------------------
APP_COMMIT="$(sed -n 's/^applicationCommit=//p' "$BUNDLE/VERSION" | head -n 1)"
[ -n "$APP_COMMIT" ] || APP_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat >"$BUNDLE/VERSION" <<VERSION
CivicWorkDesk UOS acceptance bundle
bundleId=civic-work-desk-uos-rc1-1
stage=RC1.1 (target acceptance candidate — NOT a release)
supersedes=civic-work-desk-uos-rc1
applicationCommit=$APP_COMMIT
applicationPhase=Phase 2 build, unchanged (payload byte-identical to RC1)
canonicalOrigin=$CANONICAL_ORIGIN
harnessCorrections=raw-path traversal probes; entry CSS captured; outer archive checksum; python foreground instructions; normalized tar metadata; stop-script timing comment
builtAt=$BUILT_AT
builtOn=development workstation, Node 24
serverCandidates=busybox-httpd, python3-stdlib
selectedServer=UNDECIDED — requires physical target evidence
targetTested=NO
VERSION

# ---- inner manifest ------------------------------------------------------------------------------
cd "$BUNDLE"
rm -f SHA256SUMS.txt
find . -type f ! -name 'SHA256SUMS.txt' ! -path './.runtime/*' \
  | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
      sha256sum "$file"
    done >SHA256SUMS.txt

printf 'Inner manifest: %s files\n' "$(grep -c '' SHA256SUMS.txt)"

# ---- archive -------------------------------------------------------------------------------------
#
# `--owner=0 --group=0 --numeric-owner` strips the development machine's identity: RC1 carried the
# build account's own `<name>/<gid>` pair in every tar header — a Windows account name and a Windows
# GID that mean nothing on the target and need not travel. Numeric 0/0 is portable and does **not**
# require root to extract — tar only applies ownership when it is running as root.
#
# Permissions are left as they are on disk, which is what preserves the executable bit on the
# scripts (verified below) while keeping data files read-only for others.
cd "$ROOT/release"
rm -f "$ARCHIVE" "$SIDECAR"
tar --owner=0 --group=0 --numeric-owner --exclude='.runtime' -czf "$ARCHIVE" uos-rc1-1

# ---- outer sidecar ---------------------------------------------------------------------------------
#
# Standard `sha256sum` format, so the target can run `sha256sum -c <sidecar>` directly. The path in
# the sidecar is the bare filename, so it verifies from whatever directory the tester extracted into.
( cd "$ROOT/release" && sha256sum "$(basename "$ARCHIVE")" >"$SIDECAR" )

# ---- report ----------------------------------------------------------------------------------------
printf '\nArchive : %s\n' "$ARCHIVE"
printf 'Bytes   : %s\n' "$(stat -c%s "$ARCHIVE" 2>/dev/null || wc -c <"$ARCHIVE")"
printf 'Entries : %s\n' "$(tar -tzf "$ARCHIVE" | grep -c '')"
printf 'Sidecar : %s\n' "$SIDECAR"
printf 'SHA-256 : %s\n' "$(cut -d' ' -f1 <"$SIDECAR")"

printf '\nOwnership metadata (first 3 entries):\n'
tar -tvzf "$ARCHIVE" | head -n 3 | sed 's/^/    /'
printf '\nExecutable bits on scripts:\n'
tar -tvzf "$ARCHIVE" | grep -E '\.(sh|py)$' | sed 's/^/    /'
