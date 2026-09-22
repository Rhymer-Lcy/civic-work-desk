#!/bin/sh
# Assemble the UOS RC1 target-acceptance bundle. Runs on the DEVELOPMENT machine.
#
#   sh scripts/uos/build-rc1.sh
#
# Requires `dist/` to exist and to be current. It deliberately does not run the build itself: the
# only build anyone should be shipping is the one a full gate run produced (`npm run review:package`
# builds before it tests), and a convenience rebuild here would make it possible to package a build
# that nothing has tested.
#
# Everything this writes lives under release/uos-rc1/. It creates no system state and touches
# nothing outside the repository.

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
BUNDLE="$ROOT/release/uos-rc1"
APP="$BUNDLE/app"

CANONICAL_ORIGIN="http://127.0.0.1:8765"

[ -d "$ROOT/dist" ] || {
  printf 'error: dist/ not found. Run `npm run review:package` (which builds and gates) first.\n' >&2
  exit 2
}
[ -f "$ROOT/dist/index.html" ] || {
  printf 'error: dist/index.html missing — the build is incomplete.\n' >&2
  exit 2
}

printf 'Assembling RC1 bundle in %s\n' "$BUNDLE"

# ---- application ----------------------------------------------------------------------------
# Replaced wholesale rather than merged, so a file removed from a later build cannot survive in the
# bundle as a stale asset. The target is a fixed path inside the repository, never a variable that
# could be empty.
rm -rf "$BUNDLE/app"
mkdir -p "$APP"
cp -R "$ROOT/dist/." "$APP/"

# ---- health asset ---------------------------------------------------------------------------
# Deliberately written here and not into the application's `public/`: Phase 3 must test the Phase-2
# build *unchanged*, so a deployment-only artifact must not alter the application bundle. It lives
# beside the app and is served from the same origin, which is all the launcher needs.
APP_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ENTRY_JS="$(cd "$APP" && ls assets/index-*.js 2>/dev/null | head -n 1 || true)"
ENTRY_CSS="$(cd "$APP" && ls assets/index-*.css 2>/dev/null | head -n 1 || true)"

cat >"$APP/deployment-health.json" <<JSON
{
  "application": "civic-work-desk",
  "releaseChannel": "uos-rc1",
  "releaseId": "uos-rc1",
  "canonicalOrigin": "$CANONICAL_ORIGIN",
  "applicationCommit": "$APP_COMMIT",
  "builtAt": "$BUILT_AT",
  "entry": { "js": "$ENTRY_JS", "css": "$ENTRY_CSS" },
  "note": "Deployment health probe. Contains no personal data and no secrets. The launcher fetches this to confirm the server at the canonical origin is serving the expected release before opening the browser."
}
JSON

# ---- probe ------------------------------------------------------------------------------------
# One copy of the probe is maintained, under scripts/uos/; the bundle carries a copy so the target
# needs nothing but the bundle.
mkdir -p "$BUNDLE/scripts"
cp "$ROOT/scripts/uos/probe-target.sh" "$BUNDLE/scripts/probe-target.sh"

# ---- version -----------------------------------------------------------------------------------
cat >"$BUNDLE/VERSION" <<VERSION
CivicWorkDesk UOS acceptance bundle
bundleId=civic-work-desk-uos-rc1
stage=RC1 (target acceptance candidate — NOT a release)
applicationCommit=$APP_COMMIT
applicationPhase=Phase 2 build, unchanged
canonicalOrigin=$CANONICAL_ORIGIN
builtAt=$BUILT_AT
builtOn=development workstation, Node 24
serverCandidates=busybox-httpd, python3-stdlib
selectedServer=UNDECIDED — requires physical target evidence
targetTested=NO
VERSION

# ---- manifest ----------------------------------------------------------------------------------
# Every file except the manifest itself and any runtime state a previous test left behind.
cd "$BUNDLE"
rm -f SHA256SUMS.txt
find . -type f ! -name 'SHA256SUMS.txt' ! -path './.runtime/*' \
  | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
      sha256sum "$file"
    done >SHA256SUMS.txt

COUNT="$(grep -c '' SHA256SUMS.txt)"
printf 'Bundle assembled: %s files listed in SHA256SUMS.txt\n' "$COUNT"
printf 'Application commit: %s\n' "$APP_COMMIT"
printf 'Canonical origin:   %s\n' "$CANONICAL_ORIGIN"
printf '\nSelf-check:\n'
sh "$BUNDLE/scripts/verify-files.sh" | tail -n 2
