#!/bin/sh
# Focused tests for the UOS user-level deployment. POSIX sh; must run on a real Linux host.
#
#   sh scripts/uos/deployment-tests.sh --repo /mnt/f/CivicWorkDesk
#
# Normally invoked through `npm run test:uos`, which finds a POSIX host (WSL2 on the development
# workstation) and passes the repo path.
#
# ## What these tests do and do not prove
#
# They exercise the REAL install.sh and the REAL runtime scripts against a real BusyBox httpd, a real
# /proc, real signals and real symlinks, inside a sandboxed HOME. So they prove the deployment logic:
# activation, ownership, staleness, conflict, health, upgrade, rollback, preservation.
#
# They do NOT prove anything about the target machine. The host here is x86_64 with Ubuntu's BusyBox
# 1.30.1; the target is loongarch64 with UOS's BusyBox 1.30.1. Same applet version, different build.
# Target facts come only from target evidence — see docs/phase-3-stage-b-evidence.md, which keeps the
# two apart on purpose.
#
# The application payload used here is a synthetic four-file stand-in, not `dist/`. That is
# deliberate: these tests are about the deployment, and a 23-file copy per release would make them
# slow without covering one extra branch. The real payload is covered by the archive tests in
# scripts/uos/archive-tests.mjs and by physical target acceptance.

set -eu

REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
[ -n "$REPO" ] || { printf 'usage: deployment-tests.sh --repo <path>\n' >&2; exit 2; }
[ -d "$REPO/deploy/uos" ] || { printf 'not a CivicWorkDesk repo: %s\n' "$REPO" >&2; exit 2; }

PORT=8765
PASS=0
FAIL=0
TOTAL=0
# Every assertion is counted, and the total is asserted at the end. Not decoration: the first run of
# this suite had this number wrong, and the mismatch is what said so. A block that fails to run
# otherwise looks exactly like a block that passed.
EXPECTED_TESTS=114

ok() {
  TOTAL=$((TOTAL + 1))
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
nok() {
  TOTAL=$((TOTAL + 1))
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  [ -n "${2:-}" ] && printf '       %s\n' "$2"
}
assert() {
  if [ "$1" = yes ]; then ok "$2"; else nok "$2" "${3:-}"; fi
}
group() { printf '\n--- %s\n' "$1"; }

command -v busybox >/dev/null 2>&1 || { printf 'busybox required\n' >&2; exit 2; }
busybox --list | grep -qx httpd || { printf 'busybox httpd applet required\n' >&2; exit 2; }

# ---------------------------------------------------------------- sandbox
WORK="$(mktemp -d)"
SANDBOX="$WORK/home"
BUNDLES="$WORK/bundles"
FAKEBIN="$WORK/fakebin"
mkdir -p "$SANDBOX" "$BUNDLES" "$FAKEBIN"

# The fake browser opener. Every launcher test runs with this on PATH, so the real flow — including
# the xdg-open call — is exercised without starting a browser, and "did it open the browser" becomes
# an assertion instead of an assumption.
cat >"$FAKEBIN/xdg-open" <<'FAKE'
#!/bin/sh
printf '%s\n' "$1" >>"$XDG_OPEN_MARKER"
FAKE
chmod 755 "$FAKEBIN/xdg-open"

export HOME="$SANDBOX"
export XDG_RUNTIME_DIR="$WORK/run"
mkdir -p "$XDG_RUNTIME_DIR"
export XDG_OPEN_MARKER="$WORK/xdg-open-calls"
PATH="$FAKEBIN:$PATH"
export PATH

BIN="$SANDBOX/.local/bin"
PREFIX="$SANDBOX/.local/share/civic-work-desk"
DESKTOP="$SANDBOX/.local/share/applications/civic-work-desk.desktop"

SUMMARY_PRINTED=no

cleanup() {
  # An abort is a different failure from a failed assertion, and it used to be indistinguishable: the
  # run simply ended with no summary, and a reader had to infer that from absence. Say it instead.
  if [ "$SUMMARY_PRINTED" = no ]; then
    printf '\n==================================================================\n'
    printf 'SUITE ABORTED before its summary — a command failed under `set -e`,\n'
    printf 'so the assertions after that point never ran. Assertions executed: %s.\n' "$TOTAL"
    printf 'Do not read this as "everything else passed".\n'
  fi
  # Only ever our own sandbox, and only processes recorded by our own state files or started here.
  for candidate in "$XDG_RUNTIME_DIR/civic-work-desk/httpd.pid" "$WORK/decoy.pid"; do
    [ -s "$candidate" ] || continue
    pid="$(cat "$candidate" 2>/dev/null || true)"
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- bundle builder
#
# Produces a release bundle shaped exactly like the real artifact: app/ + runtime/ + VERSION +
# SHA256SUMS.txt + install.sh. The index.html references the entry asset named in
# deployment-health.json, because the launcher's health gate cross-checks exactly that.
make_bundle() {
  id="$1"
  dir="$BUNDLES/$id"
  rm -rf "$dir"
  mkdir -p "$dir/app/assets" "$dir/app/icons" "$dir/runtime"

  entry="assets/index-$id.js"
  cat >"$dir/app/index.html" <<HTML
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>政务工作记录台</title></head>
<body><div id="root"></div><script type="module" src="./$entry"></script></body></html>
HTML
  printf 'console.log("%s");\n' "$id" >"$dir/app/$entry"
  printf 'body{}\n' >"$dir/app/assets/index-$id.css"
  printf 'self.addEventListener("install", function () {});\n' >"$dir/app/sw.js"
  printf '{"name":"civic"}\n' >"$dir/app/manifest.webmanifest"
  printf 'icon\n' >"$dir/app/icons/icon-512.png"
  cat >"$dir/app/deployment-health.json" <<JSON
{
  "application": "civic-work-desk",
  "releaseChannel": "uos20-loongarch64",
  "releaseId": "$id",
  "canonicalOrigin": "http://127.0.0.1:8765",
  "entry": { "js": "$entry", "css": "assets/index-$id.css" }
}
JSON

  for file in civic-lib.sh civic-work-desk.sh civic-work-desk-status.sh civic-work-desk-stop.sh \
    civic-work-desk-rollback.sh civic-work-desk-uninstall.sh httpd.conf civic-work-desk.desktop; do
    cp "$REPO/deploy/uos/runtime/$file" "$dir/runtime/$file"
  done
  cp "$REPO/deploy/uos/install.sh" "$dir/install.sh"
  cp "$REPO/deploy/uos/README.md" "$dir/README.md"
  chmod 755 "$dir/install.sh"

  printf 'releaseId=%s\nappVersion=0.1.0-test\n' "$id" >"$dir/VERSION"
  ( cd "$dir" && find . -type f ! -name 'SHA256SUMS.txt' | sed 's|^\./||' | LC_ALL=C sort \
    | while IFS= read -r f; do sha256sum "$f"; done >SHA256SUMS.txt )
}

health_release() {
  printf 'GET /deployment-health.json HTTP/1.0\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n' "$PORT" \
    | busybox nc 127.0.0.1 "$PORT" 2>/dev/null \
    | tr -d '\r' | sed -n 's/.*"releaseId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

our_pid() {
  cat "$XDG_RUNTIME_DIR/civic-work-desk/httpd.pid" 2>/dev/null || true
}

# Wait for the fake xdg-open to record N invocations.
#
# The launcher backgrounds the browser call — deliberately, so a slow browser cannot hold the menu
# entry open — and then exits. So the marker file is written *after* the launcher returns, and an
# assertion made the instant it returns is a race. It lost intermittently under the load of a mutation
# run, producing a failure in an unrelated section and briefly making two mutants look like they were
# caught for the wrong reason.
wait_for_opens() {
  want="$1"
  i=0
  while [ "$i" -lt 25 ]; do
    [ "$(grep -c '' "$XDG_OPEN_MARKER" 2>/dev/null || echo 0)" -ge "$want" ] && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Repoint one of the pointer symlinks, and verify it actually moved.
#
# Spelled out rather than inlined, because the obvious inline version is wrong: `mv -f` onto a symlink
# that points at a *directory* follows it and drops the new link inside that directory, leaving the
# pointer where it was while every command reports success. The harness has to get this right or the
# health-mismatch section below would silently test nothing.
repoint() {
  ln -sfn "releases/$2" "$1"
  [ "$(readlink "$1")" = "releases/$2" ] || {
    printf 'harness error: could not repoint %s to releases/%s\n' "$1" "$2" >&2
    exit 2
  }
}

printf 'CivicWorkDesk UOS deployment tests\n'
printf 'sandbox HOME: %s\n' "$SANDBOX"
printf 'busybox:      %s\n' "$(busybox 2>&1 | head -n 1)"

make_bundle relA
make_bundle relB
make_bundle relC

# ================================================================ install
group '1. install (first install, no sudo, verified before activation)'

INSTALL_OUT="$( (cd "$BUNDLES/relA" && sh install.sh --no-start) 2>&1 )" || true
assert "$([ -d "$PREFIX/releases/relA/app" ] && echo yes || echo no)" \
  "release directory created"
assert "$([ -L "$PREFIX/current" ] && echo yes || echo no)" \
  "current is a symlink"
assert "$([ "$(readlink "$PREFIX/current")" = "releases/relA" ] && echo yes || echo no)" \
  "current -> releases/relA"
assert "$([ -x "$BIN/civic-work-desk" ] && echo yes || echo no)" \
  "launcher installed and executable"
assert "$([ -r "$PREFIX/lib/civic-lib.sh" ] && echo yes || echo no)" \
  "runtime library installed"
assert "$(printf '%s' "$INSTALL_OUT" | grep -q 'sudo' && echo no || echo yes)" \
  "installer output never mentions sudo"
assert "$(printf '%s' "$INSTALL_OUT" | grep -q '通过' && echo yes || echo no)" \
  "installer reported a verification pass"

COMMAND_COUNT=0
for name in civic-work-desk civic-work-desk-status civic-work-desk-stop \
  civic-work-desk-rollback civic-work-desk-uninstall; do
  [ -x "$BIN/$name" ] && COMMAND_COUNT=$((COMMAND_COUNT + 1))
done
assert "$([ "$COMMAND_COUNT" -eq 5 ] && echo yes || echo no)" \
  "all five commands installed" "found $COMMAND_COUNT"

group '2. desktop entry'
assert "$([ -f "$DESKTOP" ] && echo yes || echo no)" "desktop entry installed"
assert "$(grep -q '@@' "$DESKTOP" && echo no || echo yes)" \
  "no unsubstituted placeholder survives"
assert "$(grep -q "^Exec=$BIN/civic-work-desk\$" "$DESKTOP" && echo yes || echo no)" \
  "Exec is the absolute installed launcher path"
assert "$(grep -q '^Terminal=false$' "$DESKTOP" && echo yes || echo no)" "Terminal=false"
assert "$(grep -qE '^(Exec|Icon)=.*(python|node|npm)' "$DESKTOP" && echo no || echo yes)" \
  "desktop entry invokes no language runtime"

# ================================================================ launch
group '3. launch and health gate'
: >"$XDG_OPEN_MARKER"
set +e
LAUNCH1="$("$BIN/civic-work-desk" 2>&1)"
LAUNCH1_RC=$?
set -e
assert "$([ "$LAUNCH1_RC" -eq 0 ] && echo yes || echo no)" "launcher exited 0" "$LAUNCH1"
PID1="$(our_pid)"
assert "$([ -n "$PID1" ] && kill -0 "$PID1" 2>/dev/null && echo yes || echo no)" \
  "server running after launch"
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "server serves the active release"
wait_for_opens 1 || true
assert "$(grep -qx 'http://127.0.0.1:8765/' "$XDG_OPEN_MARKER" && echo yes || echo no)" \
  "browser opened at exactly the canonical origin" "$(cat "$XDG_OPEN_MARKER")"
assert "$([ "$(grep -c '' "$XDG_OPEN_MARKER")" -eq 1 ] && echo yes || echo no)" \
  "browser opened exactly once"

group '4. repeated launch is idempotent'
: >"$XDG_OPEN_MARKER"
"$BIN/civic-work-desk" >/dev/null 2>&1 || true
"$BIN/civic-work-desk" >/dev/null 2>&1 || true
PID2="$(our_pid)"
assert "$([ "$PID1" = "$PID2" ] && echo yes || echo no)" \
  "same server reused across three launches" "was $PID1, now $PID2"
HTTPD_COUNT="$(busybox ps 2>/dev/null | grep 'httpd' | grep -c "$PREFIX" || true)"
assert "$([ "$HTTPD_COUNT" -le 1 ] && echo yes || echo no)" \
  "exactly one owned httpd process exists" "counted $HTTPD_COUNT"

# ================================================================ ownership
group '5. owned-process detection (the safety property)'
DECOY_ROOT="$WORK/decoy-root"
mkdir -p "$DECOY_ROOT"
printf 'decoy\n' >"$DECOY_ROOT/index.html"
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
busybox httpd -f -p "127.0.0.1:$PORT" -h "$DECOY_ROOT" >"$WORK/decoy.log" 2>&1 &
DECOY_PID=$!
printf '%s\n' "$DECOY_PID" >"$WORK/decoy.pid"
sleep 2
assert "$(kill -0 "$DECOY_PID" 2>/dev/null && echo yes || echo no)" "decoy server started"

# The decoy has the right binary and the right host:port, and differs only in its document root.
# That is the case a port-based or name-based check would get wrong.
STATUS_OUT="$("$BIN/civic-work-desk-status" 2>&1)" || true
assert "$(printf '%s' "$STATUS_OUT" | grep -q '未运行' && echo yes || echo no)" \
  "status does not claim the decoy as ours"
assert "$(printf '%s' "$STATUS_OUT" | grep -q '占用' && echo yes || echo no)" \
  "status reports the port as occupied by another process"

STOP_OUT="$("$BIN/civic-work-desk-stop" 2>&1)" || true
assert "$(kill -0 "$DECOY_PID" 2>/dev/null && echo yes || echo no)" \
  "stop did NOT kill the foreign process holding the port"
assert "$(printf '%s' "$STOP_OUT" | grep -q '没有正在运行' && echo yes || echo no)" \
  "stop reported nothing of ours was running"

# The harder case, and the one the document-root condition actually exists for: PID REUSE. Our own
# PID file names a process that IS a BusyBox httpd on the canonical port — it is simply not ours.
# Without the install-prefix condition in civic_pid_is_ours, everything above still passes (measured:
# dropping that condition left all other assertions green), because the decoy's PID never reaches our
# state file by itself. Here it is put there deliberately.
mkdir -p "$XDG_RUNTIME_DIR/civic-work-desk"
printf '%s\n' "$DECOY_PID" >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.pid"
REUSE_STATUS="$("$BIN/civic-work-desk-status" 2>&1)" || true
assert "$(printf '%s' "$REUSE_STATUS" | grep -q '未运行' && echo yes || echo no)" \
  "status rejects a foreign httpd even when our own PID file names it"
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
assert "$(kill -0 "$DECOY_PID" 2>/dev/null && echo yes || echo no)" \
  "stop refused to signal a foreign httpd named by our own PID file"
assert "$([ -z "$(our_pid)" ] && echo yes || echo no)" \
  "the mis-owned PID file was cleared rather than trusted"

group '6. port conflict is reported, not resolved'
: >"$XDG_OPEN_MARKER"
set +e
CONFLICT_OUT="$("$BIN/civic-work-desk" 2>&1)"
CONFLICT_RC=$?
set -e
assert "$([ "$CONFLICT_RC" -ne 0 ] && echo yes || echo no)" "launcher failed loudly"
assert "$(printf '%s' "$CONFLICT_OUT" | grep -q "$PORT" && echo yes || echo no)" \
  "message names the port"
assert "$(kill -0 "$DECOY_PID" 2>/dev/null && echo yes || echo no)" \
  "conflicting process still alive after the failed launch"
# A short settle before asserting the marker is EMPTY. The write, if it happened, would be racing us,
# and a not-yet-written marker would make this pass for the wrong reason — the direction of failure
# that looks like success.
sleep 2
assert "$([ -s "$XDG_OPEN_MARKER" ] && echo no || echo yes)" \
  "browser was NOT opened on conflict"
assert "$([ -z "$(our_pid)" ] && echo yes || echo no)" \
  "no server of ours was left behind"

kill "$DECOY_PID" 2>/dev/null || true
: >"$WORK/decoy.pid"
sleep 1

# ================================================================ stale pid
group '7. stale PID file'
"$BIN/civic-work-desk" --no-browser >/dev/null 2>&1 || true
GOOD_PID="$(our_pid)"
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true

# A PID that exists but is something else entirely — the PID-reuse case.
sleep 300 &
SLEEPER=$!
mkdir -p "$XDG_RUNTIME_DIR/civic-work-desk"
printf '%s\n' "$SLEEPER" >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.pid"
STALE_STATUS="$("$BIN/civic-work-desk-status" 2>&1)" || true
assert "$(printf '%s' "$STALE_STATUS" | grep -q '未运行' && echo yes || echo no)" \
  "status rejects a reused PID"
assert "$(kill -0 "$SLEEPER" 2>/dev/null && echo yes || echo no)" \
  "the unrelated process was not signalled"
"$BIN/civic-work-desk" --no-browser >/dev/null 2>&1 || true
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "launcher recovered from the stale PID and started cleanly"
kill "$SLEEPER" 2>/dev/null || true

# A PID that does not exist at all.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
printf '999999\n' >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.pid"
"$BIN/civic-work-desk" --no-browser >/dev/null 2>&1 || true
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "launcher recovered from a nonexistent PID"

# ================================================================ upgrade
group '8. upgrade switches release and preserves the previous one'
UPGRADE_OUT="$( (cd "$BUNDLES/relB" && sh install.sh --no-start) 2>&1 )" || true
assert "$([ "$(readlink "$PREFIX/current")" = "releases/relB" ] && echo yes || echo no)" \
  "current -> releases/relB"
assert "$([ "$(readlink "$PREFIX/previous")" = "releases/relA" ] && echo yes || echo no)" \
  "previous -> releases/relA"
assert "$([ -d "$PREFIX/releases/relA/app" ] && echo yes || echo no)" \
  "previous release files preserved"

group '9. health mismatch after a release switch'
# The server was left running against relA before the upgrade; BusyBox resolved its document root at
# startup, so it is still serving relA. The launcher must notice and restart rather than hand the
# user a stale application.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
repoint "$PREFIX/current" relA
"$BIN/civic-work-desk" --no-browser >/dev/null 2>&1 || true
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" "serving relA before the switch"
repoint "$PREFIX/current" relB
MISMATCH_STATUS="$("$BIN/civic-work-desk-status" 2>&1)" || true
assert "$(printf '%s' "$MISMATCH_STATUS" | grep -q '不一致' && echo yes || echo no)" \
  "status detects the stale document root"
"$BIN/civic-work-desk" --no-browser >/dev/null 2>&1 || true
assert "$([ "$(health_release)" = relB ] && echo yes || echo no)" \
  "launcher restarted the server onto the new release"

group '10. rollback'
ROLLBACK_OUT="$("$BIN/civic-work-desk-rollback" --yes 2>&1)" || true
assert "$([ "$(readlink "$PREFIX/current")" = "releases/relA" ] && echo yes || echo no)" \
  "rollback switched current to the previous release"
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "server serves the rolled-back release"
assert "$(printf '%s' "$ROLLBACK_OUT" | grep -q '不支持数据库降级' && echo yes || echo no)" \
  "rollback states that database downgrade is not supported"

# ================================================================ stop
group '11. stop'
STOP2="$("$BIN/civic-work-desk-stop" 2>&1)" || true
assert "$([ -z "$(our_pid)" ] && echo yes || echo no)" "pid file cleared after stop"
set +e
"$BIN/civic-work-desk-status" >/dev/null 2>&1
STATUS_RC=$?
set -e
assert "$([ "$STATUS_RC" -eq 1 ] && echo yes || echo no)" \
  "status exits 1 when not running" "got $STATUS_RC"

# ================================================================ minimal environments
group '12. no setsid, and one HTTP client at a time'
#
# Everything above ran with the full development PATH: setsid present, GNU curl and GNU wget present.
# The target may have none of those. Two branches had therefore never executed, and one of them was
# broken:
#
#   `busybox wget -q -T 5 -O - <url>` SEGFAULTS on BusyBox 1.30.1 (exit 139, no output), while the
#   same command without `-T` works. Since `command -v wget` resolves to BusyBox's wget on a
#   BusyBox-centric system, the health gate would have died on exactly the machines this deployment
#   targets — and the symptom would have been "the application will not open" with a perfectly
#   healthy server behind it. The timeout is now applied with `timeout(1)` from outside instead.
#
# `setsid` cannot be masked by prepending to PATH, because `command -v` would find the real one
# further along. So the PATH is built from scratch, out of symlinks to real binaries — and `sh` is the
# real /bin/sh, not BusyBox's, because BusyBox's shell exposes every applet (including setsid) without
# a PATH lookup at all. That was measured: `busybox sh -c 'command -v setsid'` answers, `dash` does not.
minbin() {
  dir="$1"
  shift
  mkdir -p "$dir"
  # The launcher's real external-command dependencies. Deriving this list is half the value of the
  # section: `head` was missing from the first version, and the launcher failed with
  # "head: not found" followed by 「服务返回的版本信息无法解析」 — a health-gate failure whose stated
  # cause pointed at the server rather than at the shell. All of these are POSIX and present in both
  # coreutils and BusyBox, so the dependency is acceptable; what was not acceptable was not knowing it.
  for tool in sh date mkdir rmdir cat head readlink basename sleep tr sed grep rm mv ln wc timeout; do
    src="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$src" ] || {
      printf 'harness error: this host has no %s\n' "$tool" >&2
      exit 2
    }
    ln -sf "$src" "$dir/$tool"
  done
  ln -sf "$(command -v busybox)" "$dir/busybox"
  cp "$FAKEBIN/xdg-open" "$dir/xdg-open"
  for client in "$@"; do
    case "$client" in
      curl) ln -sf "$(command -v curl)" "$dir/curl" ;;
      busybox-wget) ln -sf "$(command -v busybox)" "$dir/wget" ;;
    esac
  done
}

MIN_ALL_OUT=""
run_in_minbin() {
  dir="$1"
  "$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
  : >"$XDG_OPEN_MARKER"
  set +e
  MIN_OUT="$(PATH="$dir" XDG_OPEN_MARKER="$XDG_OPEN_MARKER" HOME="$SANDBOX" \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" "$dir/sh" "$BIN/civic-work-desk" 2>&1)"
  MIN_RC=$?
  set -e
  MIN_ALL_OUT="$MIN_ALL_OUT
$MIN_OUT"
}

CURLBIN="$WORK/minbin-curl"
WGETBIN="$WORK/minbin-bbwget"
minbin "$CURLBIN" curl
minbin "$WGETBIN" busybox-wget

MIN_HAS_SETSID="$(PATH="$CURLBIN" "$CURLBIN/sh" -c 'command -v setsid >/dev/null 2>&1 && echo yes || echo no')"
assert "$([ "$MIN_HAS_SETSID" = no ] && echo yes || echo no)" \
  "setsid is genuinely absent from the crafted environment" "got $MIN_HAS_SETSID"

run_in_minbin "$CURLBIN"
assert "$([ "$MIN_RC" -eq 0 ] && echo yes || echo no)" \
  "launcher succeeds with curl only and no setsid" "$MIN_OUT"
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "health gate passed through curl"

run_in_minbin "$WGETBIN"
assert "$([ "$MIN_RC" -eq 0 ] && echo yes || echo no)" \
  "launcher succeeds with a wget that is BusyBox, and no setsid" "$MIN_OUT"
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "health gate passed through the generic wget branch (-T segfault regression)"

# And the third environment: no curl, and nothing on PATH *named* wget. The client chain then reaches
# its `busybox-wget` case, which the previous environment never selects — `command -v wget` finds the
# symlink there and takes the generic branch instead. Found by mutation testing: planting the `-T`
# segfault in the busybox-wget case passed all 67 assertions until this environment existed.
BBBIN="$WORK/minbin-bbonly"
minbin "$BBBIN"
run_in_minbin "$BBBIN"
assert "$([ "$MIN_RC" -eq 0 ] && echo yes || echo no)" \
  "launcher succeeds with only BusyBox's own wget applet" "$MIN_OUT"
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "health gate passed through the busybox-wget branch (-T segfault regression)"

# The `nc` branch cannot be driven through the launcher on this host: it is reached only when BusyBox
# has no wget applet, and this BusyBox has one. So the command line itself is checked directly, and
# that limit is stated rather than papered over — the branch is verified, the selection path into it
# is not.
NC_BODY="$(printf 'GET /deployment-health.json HTTP/1.0\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n' "$PORT" \
  | timeout 8 busybox nc 127.0.0.1 "$PORT" 2>/dev/null | tr -d '\r' | sed -e '1,/^$/d')"
assert "$(printf '%s' "$NC_BODY" | grep -q '"releaseId"' && echo yes || echo no)" \
  "the nc fallback command line returns the health body (branch checked directly)"

MIN_PID="$(our_pid)"
assert "$([ -n "$MIN_PID" ] && kill -0 "$MIN_PID" 2>/dev/null && echo yes || echo no)" \
  "the server outlived the launcher without setsid" "pid=${MIN_PID:-none}"

# The generic guard. A missing command produces "<tool>: not found" and then some *other*, misleading
# error — so name it directly instead of leaving the next reader to infer it from an exit code.
assert "$(printf '%s' "$MIN_ALL_OUT" | grep -q 'not found' && echo no || echo yes)" \
  "no external command was missing in either minimal environment" \
  "$(printf '%s' "$MIN_ALL_OUT" | grep 'not found' | head -n 3)"

# ================================================================ second upgrade
group '13. second upgrade, where BOTH pointers already exist'
# The first upgrade only exercised creating `previous`. This one overwrites a `previous` that already
# points somewhere — the other half of the symlink bug, and the half a single upgrade test hides.
# State on entry: current -> relA, previous -> relB.
UPGRADE2_OUT="$( (cd "$BUNDLES/relC" && sh install.sh --no-start) 2>&1 )" || true
assert "$([ "$(readlink "$PREFIX/current")" = "releases/relC" ] && echo yes || echo no)" \
  "current -> releases/relC" "$(readlink "$PREFIX/current")"
assert "$([ "$(readlink "$PREFIX/previous")" = "releases/relA" ] && echo yes || echo no)" \
  "previous was overwritten to releases/relA" "$(readlink "$PREFIX/previous")"
assert "$([ -d "$PREFIX/releases/relB" ] && echo no || echo yes)" \
  "the release that fell out of the keep-window was pruned"
assert "$(printf '%s' "$UPGRADE2_OUT" | grep -q '已清理旧版本目录：relB' && echo yes || echo no)" \
  "the pruning was reported rather than silent"

# ================================================================ installer fault injection
group '14. installer faults leave the running installation usable'
#
# Every failure below is injected, not simulated: a corrupted bundle byte, an unwritable path, or a
# tool that fails on a chosen invocation via a PATH shim. What is asserted is never just the exit
# status — it is the state afterwards: which release `current` names, whether the owned server is
# still serving it, and whether a half-written release directory was left behind.
#
# This is the section the staging redesign exists for. The previous installer stopped the server and
# (with --force) deleted the installed directory before the replacement was written, so a failure at
# the wrong moment left nothing working while the comments promised otherwise.
make_bundle relD
REAL_SHA="$(command -v sha256sum)"
REAL_LN="$(command -v ln)"
REAL_MV="$(command -v mv)"
FAULTBIN="$WORK/faultbin"
mkdir -p "$FAULTBIN"

# Establish a known-good baseline: relA active, server running and healthy.
repoint "$PREFIX/current" relA
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
"$BIN/civic-work-desk" --no-browser >/dev/null 2>&1 || true
BASE_PID="$(our_pid)"
assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
  "baseline: relA active and served"

# A single helper so every fault case asserts the same four things about the aftermath.
assert_survived() {
  label="$1"
  assert "$([ "$(readlink "$PREFIX/current")" = "releases/relA" ] && echo yes || echo no)" \
    "$label: current still points at relA" "$(readlink "$PREFIX/current")"
  assert "$([ "$(health_release)" = relA ] && echo yes || echo no)" \
    "$label: the running server still serves relA"
}

# ---- fault 1: the bundle itself is corrupt -----------------------------------------------------
printf 'x-corrupted\n' >>"$BUNDLES/relD/app/index.html"
set +e
F1_OUT="$( (cd "$BUNDLES/relD" && sh install.sh --no-start) 2>&1 )"
F1_RC=$?
set -e
assert "$([ "$F1_RC" -ne 0 ] && echo yes || echo no)" "corrupt bundle: install refused" "$F1_OUT"
assert "$([ -d "$PREFIX/releases/relD" ] && echo no || echo yes)" \
  "corrupt bundle: no release directory was created"
assert_survived "corrupt bundle"
make_bundle relD

# ---- fault 2: staging cannot be created -------------------------------------------------------
# `.staging` is made a regular file, so `mkdir -p` under it fails. A full disk fails the same way.
rm -rf "$PREFIX/.staging"
printf 'not a directory\n' >"$PREFIX/.staging"
set +e
F2_OUT="$( (cd "$BUNDLES/relD" && sh install.sh --no-start) 2>&1 )"
F2_RC=$?
set -e
rm -f "$PREFIX/.staging"
assert "$([ "$F2_RC" -ne 0 ] && echo yes || echo no)" "staging failure: install refused" "$F2_OUT"
assert "$([ -d "$PREFIX/releases/relD" ] && echo no || echo yes)" \
  "staging failure: no release directory was created"
assert_survived "staging failure"

# ---- fault 3: the staged copy fails verification ----------------------------------------------
# A shim that lets the source check pass and fails the staged check, which is the case a source-only
# check cannot see: a short write or a full disk produces a truncated copy of a perfect bundle.
cat >"$FAULTBIN/sha256sum" <<SHIM
#!/bin/sh
n=\$(cat "$WORK/sha-count" 2>/dev/null || echo 0)
n=\$((n + 1))
printf '%s\n' "\$n" >"$WORK/sha-count"
if [ "\$n" -ge 2 ]; then
  printf 'injected staged-verification failure\n' >&2
  exit 1
fi
exec "$REAL_SHA" "\$@"
SHIM
chmod 755 "$FAULTBIN/sha256sum"
: >"$WORK/sha-count"
set +e
F3_OUT="$( (cd "$BUNDLES/relD" && PATH="$FAULTBIN:$PATH" sh install.sh --no-start) 2>&1 )"
F3_RC=$?
set -e
rm -f "$FAULTBIN/sha256sum"
assert "$([ "$F3_RC" -ne 0 ] && echo yes || echo no)" \
  "staged-verify failure: install refused" "$F3_OUT"
assert "$([ -d "$PREFIX/releases/relD" ] && echo no || echo yes)" \
  "staged-verify failure: no release directory was left behind"
assert "$(find "$PREFIX/.staging" -maxdepth 1 -mindepth 1 2>/dev/null | grep -q . && echo no || echo yes)" \
  "staged-verify failure: the staging directory was cleaned up"
assert_survived "staged-verify failure"

# ---- fault 4: the activation pointer cannot be written ----------------------------------------
# Both mechanisms civic_set_pointer can use are blocked, and only for the `current` pointer, so the
# failure lands exactly where it matters: after the new release is staged and in place.
cat >"$FAULTBIN/mv" <<SHIM
#!/bin/sh
for a in "\$@"; do
  case "\$a" in */current) printf 'injected pointer failure\n' >&2; exit 1 ;; esac
done
exec "$REAL_MV" "\$@"
SHIM
cat >"$FAULTBIN/ln" <<SHIM
#!/bin/sh
for a in "\$@"; do
  case "\$a" in */current) printf 'injected pointer failure\n' >&2; exit 1 ;; esac
done
exec "$REAL_LN" "\$@"
SHIM
chmod 755 "$FAULTBIN/mv" "$FAULTBIN/ln"
set +e
F4_OUT="$( (cd "$BUNDLES/relD" && PATH="$FAULTBIN:$PATH" sh install.sh --no-start) 2>&1 )"
F4_RC=$?
set -e
rm -f "$FAULTBIN/mv" "$FAULTBIN/ln"
assert "$([ "$F4_RC" -ne 0 ] && echo yes || echo no)" \
  "pointer failure: install reported failure" "$F4_OUT"
assert_survived "pointer failure"
assert "$(printf '%s' "$F4_OUT" | grep -q '重新运行' && echo yes || echo no)" \
  "pointer failure: the message says re-running the installer will finish the job"

# ---- fault 5: resume finishes the interrupted activation --------------------------------------
# relD's directory is now on disk from fault 4 but was never activated. A plain re-run must verify it
# and activate it, without copying again.
set +e
F5_OUT="$( (cd "$BUNDLES/relD" && sh install.sh --no-start) 2>&1 )"
F5_RC=$?
set -e
assert "$([ "$F5_RC" -eq 0 ] && echo yes || echo no)" "resume: install succeeded" "$F5_OUT"
assert "$(printf '%s' "$F5_OUT" | grep -q '续做启用步骤' && echo yes || echo no)" \
  "resume: it said it was resuming rather than re-copying"
assert "$([ "$(readlink "$PREFIX/current")" = "releases/relD" ] && echo yes || echo no)" \
  "resume: relD is now active" "$(readlink "$PREFIX/current")"

# ---- fault 6: same release, already active ----------------------------------------------------
set +e
F6_OUT="$( (cd "$BUNDLES/relD" && sh install.sh --no-start) 2>&1 )"
F6_RC=$?
set -e
assert "$([ "$F6_RC" -eq 0 ] && echo yes || echo no)" "same release: exits 0 without acting" "$F6_OUT"
assert "$([ -f "$PREFIX/releases/relD/app/index.html" ] && echo yes || echo no)" \
  "same release: the installed files were not disturbed"
assert "$(printf '%s' "$F6_OUT" | grep -q '重新出包' && echo yes || echo no)" \
  "same release: the operator is told what to do instead"

# ---- fault 7: --force is gone --------------------------------------------------------------------
set +e
F7_OUT="$( (cd "$BUNDLES/relD" && sh install.sh --force) 2>&1 )"
F7_RC=$?
set -e
assert "$([ "$F7_RC" -ne 0 ] && echo yes || echo no)" "--force is rejected" "$F7_OUT"
assert "$([ -f "$PREFIX/releases/relD/app/index.html" ] && echo yes || echo no)" \
  "--force did not delete anything"

# ---- fault 8: desktop entry cannot be written --------------------------------------------------
# The directory is made read-only rather than replaced by a file: `mkdir -p` on an existing directory
# still succeeds, so the run reaches the desktop step with the release already activated — which is
# the case under test. Replacing it with a file would instead abort earlier, testing something else.
make_bundle relE
mkdir -p "$SANDBOX/.local/share/applications"
chmod 500 "$SANDBOX/.local/share/applications"
set +e
F8_OUT="$( (cd "$BUNDLES/relE" && sh install.sh --no-start) 2>&1 )"
F8_RC=$?
set -e
chmod 700 "$SANDBOX/.local/share/applications"
assert "$([ "$F8_RC" -ne 0 ] && echo yes || echo no)" \
  "desktop failure: reported as a failure" "$F8_OUT"
assert "$([ "$(readlink "$PREFIX/current")" = "releases/relE" ] && echo yes || echo no)" \
  "desktop failure: the release is still activated (it is usable without a menu entry)"
assert "$(printf '%s' "$F8_OUT" | grep -q 'civic-work-desk' && echo yes || echo no)" \
  "desktop failure: the message gives the command to start it with"

# ================================================================ stop safety
group '15. stop never escalates to SIGKILL against an unproven PID'
#
# A stand-in is used rather than the real server, because what has to be controlled is (a) ignoring
# SIGTERM so the ten-second window is actually entered, and (b) changing identity inside it. The
# stand-in is built to pass every ownership check: its command line carries `httpd`, the canonical
# host:port and the install prefix, and its real start time is recorded as the token.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true

start_stubborn() {
  # A process that ignores TERM and looks exactly like ours.
  sh -c 'trap "" TERM; while :; do sleep 1; done' \
    httpd -f -p "127.0.0.1:$PORT" -h "$PREFIX/current/app" &
  STUB_PID=$!
  mkdir -p "$XDG_RUNTIME_DIR/civic-work-desk"
  printf '%s\n' "$STUB_PID" >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.pid"
  printf '%s\n' "$PREFIX/current/app" >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.root"
  printf 'relE\n' >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.release"
  # Its genuine start time, read the same way the library reads it.
  rest="$(sed 's/^.*) //' "/proc/$STUB_PID/stat")"
  # shellcheck disable=SC2086
  set -- $rest
  printf '%s\n' "${20}" >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.starttime"
}

# 15a: identity holds throughout — escalation to SIGKILL is correct and must happen.
start_stubborn
STUB_A="$STUB_PID"
sleep 1
assert "$([ -n "$(our_pid)" ] && echo yes || echo no)" \
  "the stand-in is accepted as ours (so the test is testing something)"
set +e
"$BIN/civic-work-desk-stop" >/dev/null 2>&1
STOP_A_RC=$?
set -e
assert "$(kill -0 "$STUB_A" 2>/dev/null && echo no || echo yes)" \
  "identity intact: a TERM-ignoring server of ours is force-stopped"
assert "$([ "$STOP_A_RC" -eq 0 ] && echo yes || echo no)" \
  "identity intact: stop reports success" "rc=$STOP_A_RC"

# 15b: identity changes inside the wait — SIGKILL must NOT be sent.
start_stubborn
STUB_B="$STUB_PID"
sleep 1
# Note the `set +e`: civic-lib.sh carries `set -eu`, so sourcing it makes a non-zero return abort this
# helper before it can record the status — which is exactly what happened the first time, leaving an
# empty file and an assertion that read `rc=`.
cat >"$WORK/do-stop.sh" <<STOPPER
#!/bin/sh
. "$PREFIX/lib/civic-lib.sh"
set +e
civic_server_stop >/dev/null 2>&1
rc=\$?
set -e
printf '%s\n' "\$rc" >"$WORK/stop-rc"
STOPPER
chmod 755 "$WORK/do-stop.sh"
: >"$WORK/stop-rc"
sh "$WORK/do-stop.sh" &
STOPPER_PID=$!
# Two seconds in — well inside the ten-second wait — the recorded identity stops matching.
sleep 2
printf '999999999\n' >"$XDG_RUNTIME_DIR/civic-work-desk/httpd.starttime"
wait "$STOPPER_PID" 2>/dev/null || true
STOP_B_RC="$(cat "$WORK/stop-rc" 2>/dev/null || echo missing)"
assert "$(kill -0 "$STUB_B" 2>/dev/null && echo yes || echo no)" \
  "identity changed mid-stop: the process was NOT signalled with SIGKILL"
assert "$([ "$STOP_B_RC" = 2 ] && echo yes || echo no)" \
  "identity changed mid-stop: stop reports the refusal distinctly (rc=2)" "rc=$STOP_B_RC"
assert "$([ -z "$(our_pid)" ] && echo yes || echo no)" \
  "identity changed mid-stop: our runtime state was cleared"
kill -9 "$STUB_B" 2>/dev/null || true

# ================================================================ launcher lock
group '16. launcher lock recovers from every abandoned shape'
#
# The lock is a symlink whose target IS the holder PID, so "a lock with no holder" cannot exist — the
# shape that used to hang a launcher for thirty seconds and then fail. What remains is to prove that
# every *abandoned* shape is recovered and that a genuinely live holder is still respected.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
repoint "$PREFIX/current" relE
LOCK="$XDG_RUNTIME_DIR/civic-work-desk/launcher.lock"
mkdir -p "$XDG_RUNTIME_DIR/civic-work-desk"

# 16a: a holder that no longer exists.
rm -f "$LOCK"
ln -s 999999 "$LOCK"
set +e
L1_OUT="$("$BIN/civic-work-desk" --no-browser 2>&1)"
L1_RC=$?
set -e
assert "$([ "$L1_RC" -eq 0 ] && echo yes || echo no)" "dead holder: lock broken and launch proceeded" "$L1_OUT"
assert "$([ "$(health_release)" = relE ] && echo yes || echo no)" "dead holder: server healthy afterwards"

# 16b: a holder that is not a number at all.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
rm -f "$LOCK"
ln -s not-a-pid "$LOCK"
set +e
L2_OUT="$("$BIN/civic-work-desk" --no-browser 2>&1)"
L2_RC=$?
set -e
assert "$([ "$L2_RC" -eq 0 ] && echo yes || echo no)" "garbage holder: lock broken" "$L2_OUT"

# 16c: the holder PID is alive but belongs to something unrelated — the PID-reuse case.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
sleep 300 &
UNRELATED=$!
rm -f "$LOCK"
ln -s "$UNRELATED" "$LOCK"
set +e
L3_OUT="$("$BIN/civic-work-desk" --no-browser 2>&1)"
L3_RC=$?
set -e
assert "$([ "$L3_RC" -eq 0 ] && echo yes || echo no)" "reused holder PID: lock broken" "$L3_OUT"
assert "$(kill -0 "$UNRELATED" 2>/dev/null && echo yes || echo no)" \
  "reused holder PID: the unrelated process was not touched"
kill "$UNRELATED" 2>/dev/null || true

# 16d: a genuinely live launcher holds it — must be respected, then released.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
sh -c 'sleep 25' civic-work-desk &
FAKE_LAUNCHER=$!
rm -f "$LOCK"
ln -s "$FAKE_LAUNCHER" "$LOCK"
: >"$WORK/waiter-rc"
sh -c "\"$BIN/civic-work-desk\" --no-browser >/dev/null 2>&1; printf '%s\n' \$? >\"$WORK/waiter-rc\"" &
WAITER=$!
sleep 3
assert "$([ -z "$(our_pid)" ] && echo yes || echo no)" \
  "live holder: the second launcher waited instead of starting a server"
rm -f "$LOCK"
kill "$FAKE_LAUNCHER" 2>/dev/null || true
wait "$WAITER" 2>/dev/null || true
assert "$([ "$(cat "$WORK/waiter-rc" 2>/dev/null)" = 0 ] && echo yes || echo no)" \
  "live holder: once the lock was released the launcher completed" "rc=$(cat "$WORK/waiter-rc" 2>/dev/null)"

# 16e: two launchers at once — one server, both satisfied.
"$BIN/civic-work-desk-stop" >/dev/null 2>&1 || true
rm -f "$LOCK"
: >"$WORK/race-a"
: >"$WORK/race-b"
sh -c "\"$BIN/civic-work-desk\" --no-browser >/dev/null 2>&1; printf '%s\n' \$? >\"$WORK/race-a\"" &
RA=$!
sh -c "\"$BIN/civic-work-desk\" --no-browser >/dev/null 2>&1; printf '%s\n' \$? >\"$WORK/race-b\"" &
RB=$!
wait "$RA" 2>/dev/null || true
wait "$RB" 2>/dev/null || true
RACE_COUNT="$(busybox ps 2>/dev/null | grep 'httpd' | grep -c "$PREFIX" || true)"
assert "$([ "$RACE_COUNT" -le 1 ] && echo yes || echo no)" \
  "simultaneous launches: exactly one owned server exists" "counted $RACE_COUNT"
assert "$([ "$(cat "$WORK/race-a" 2>/dev/null)" = 0 ] && [ "$(cat "$WORK/race-b" 2>/dev/null)" = 0 ] && echo yes || echo no)" \
  "simultaneous launches: both exited 0" "a=$(cat "$WORK/race-a" 2>/dev/null) b=$(cat "$WORK/race-b" 2>/dev/null)"

# 16f: the lock carries its holder atomically, by construction.
assert "$([ -L "$LOCK" ] || [ ! -e "$LOCK" ] && echo yes || echo no)" \
  "the lock is a symlink (so it cannot exist without naming a holder)"

# ================================================================ uninstall
group '17. uninstall preserves user data'
mkdir -p "$SANDBOX/Downloads" "$SANDBOX/.config/com.360.browser/Default"
printf '{"backup":true}\n' >"$SANDBOX/Downloads/civic-backup.json"
printf 'x\n' >"$SANDBOX/Downloads/report.xlsx"
printf 'profile\n' >"$SANDBOX/.config/com.360.browser/Default/Preferences"

UNINSTALL_OUT="$("$BIN/civic-work-desk-uninstall" --yes 2>&1)" || true
assert "$([ -d "$PREFIX" ] && echo no || echo yes)" "program files removed"
assert "$([ -e "$DESKTOP" ] && echo no || echo yes)" "desktop entry removed"
assert "$([ -e "$BIN/civic-work-desk" ] && echo no || echo yes)" "commands removed"
assert "$([ -f "$SANDBOX/Downloads/civic-backup.json" ] && echo yes || echo no)" \
  "JSON backup in Downloads preserved"
assert "$([ -f "$SANDBOX/Downloads/report.xlsx" ] && echo yes || echo no)" \
  "exported report preserved"
assert "$([ -f "$SANDBOX/.config/com.360.browser/Default/Preferences" ] && echo yes || echo no)" \
  "360 browser profile untouched"
assert "$(printf '%s' "$UNINSTALL_OUT" | grep -q '浏览器中仍然保留' && echo yes || echo no)" \
  "uninstall warns that browser-resident data remains"

# ================================================================ summary
SUMMARY_PRINTED=yes
printf '\n==================================================================\n'
printf 'tests run: %s   pass: %s   fail: %s\n' "$TOTAL" "$PASS" "$FAIL"

# A count assertion, because a block that silently failed to run would otherwise look like a pass:
# every `ok` line is real, there are just fewer of them than the suite claims to contain.
if [ "$TOTAL" -ne "$EXPECTED_TESTS" ]; then
  printf 'RESULT: FAIL — expected %s assertions, executed %s. A test block did not run.\n' \
    "$EXPECTED_TESTS" "$TOTAL"
  exit 1
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'RESULT: PASS\n'
  exit 0
fi
printf 'RESULT: FAIL\n'
exit 1
