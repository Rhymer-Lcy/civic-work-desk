#!/bin/sh
# CivicWorkDesk — UOS target environment probe (READ-ONLY)
#
# Collects the facts Phase 3 needs in order to choose a local static server, a launch method and a
# fixed origin, on the workstation where the product will actually run. It reads; it never installs,
# removes, configures or writes anywhere except the single report file you name.
#
# Usage:
#   sh probe-target.sh [output-file]
#
# With no argument the report is written next to this script as
# civic-work-desk-probe-<host-agnostic timestamp>.txt and the path is printed at the end.
#
# ## Why POSIX sh and not bash
#
# The target's shell has not been observed. `/bin/sh` exists on every Linux system this could
# plausibly be, and nothing here needs more than POSIX. Confirming bash and then depending on it
# would be a second unknown for no gain.
#
# ## Privacy
#
# Deliberately NOT collected: browser history, cookies, bookmarks, profile contents, home-directory
# listings, document names, network configuration, running-process lists, or anything belonging to
# another user. The 360 browser profile is touched only to answer "does this path exist", and even
# that is reported as a yes/no rather than a listing. `id` is included because UID/GID and sudo
# membership are load-bearing for a non-root install; strip the username from the report before
# sharing if you prefer — the deployment decisions do not need it.

set -eu

REPORT="${1:-}"
if [ -z "$REPORT" ]; then
  # `date` is in coreutils on any UOS; if it is somehow missing, fall back to a fixed name rather
  # than failing the whole probe over a filename.
  STAMP="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo unknown-time)"
  SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
  REPORT="$SCRIPT_DIR/civic-work-desk-probe-$STAMP.txt"
fi

CANONICAL_HOST="127.0.0.1"
CANONICAL_PORT="8765"
BROWSER_EXE="/opt/apps/com.360.browser-stable/files/com.360.browser-stable"

# ---------------------------------------------------------------- reporting helpers

out() { printf '%s\n' "$*" >>"$REPORT"; }

section() {
  out ""
  out "=============================================================================="
  out "$*"
  out "=============================================================================="
}

# Report a command's existence and version without letting a missing command abort the run.
# Absence is a valid result (§13), so every probe is wrapped rather than guarded by `set -e`.
probe_cmd() {
  name="$1"
  shift
  path="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$path" ]; then
    out "$name: NOT FOUND"
    return 0
  fi
  out "$name: $path"
  if [ "$#" -gt 0 ]; then
    version="$("$@" 2>&1 | head -n 3 || true)"
    printf '%s\n' "$version" | sed 's/^/    /' >>"$REPORT"
  fi
}

probe_file() {
  label="$1"
  path="$2"
  if [ -e "$path" ]; then
    out "$label: EXISTS ($path)"
    if [ -x "$path" ]; then out "    executable: yes"; else out "    executable: no"; fi
  else
    out "$label: NOT FOUND ($path)"
  fi
}

# ---------------------------------------------------------------- start

: >"$REPORT"
out "CivicWorkDesk — UOS target environment probe"
out "generated: $(date -Iseconds 2>/dev/null || date 2>/dev/null || echo unknown)"
out "probe version: 1 (Phase-3 RC1)"
out ""
out "This report is READ-ONLY output. Nothing on this machine was modified."

section "1. Operating system"
if [ -r /etc/os-release ]; then
  sed 's/^/    /' /etc/os-release >>"$REPORT"
else
  out "/etc/os-release: NOT READABLE"
fi
out ""
out "uname -a:"
out "    $(uname -a 2>/dev/null || echo unavailable)"
out "uname -m:"
out "    $(uname -m 2>/dev/null || echo unavailable)"
out "uname -r:"
out "    $(uname -r 2>/dev/null || echo unavailable)"

section "2. User and session"
out "id:"
out "    $(id 2>/dev/null || echo unavailable)"
out "umask:"
out "    $(umask 2>/dev/null || echo unavailable)"
out ""
for var in XDG_CURRENT_DESKTOP DESKTOP_SESSION HOME XDG_RUNTIME_DIR XDG_DATA_HOME \
  XDG_STATE_HOME XDG_CONFIG_HOME XDG_CACHE_HOME SHELL LANG; do
  # eval is the POSIX way to read a variable by name; the names are a fixed literal list above,
  # so nothing user-controlled reaches it.
  value="$(eval "printf '%s' \"\${$var:-}\"")"
  if [ -z "$value" ]; then
    out "$var: (unset)"
  else
    out "$var: $value"
  fi
done
out ""
out "Writability of the intended user-level install roots:"
for dir in "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_STATE_HOME:-$HOME/.local/state}" \
  "$HOME/.local/bin" "${XDG_RUNTIME_DIR:-}"; do
  [ -z "$dir" ] && continue
  if [ -d "$dir" ]; then
    if [ -w "$dir" ]; then out "    $dir: exists, writable"; else out "    $dir: exists, NOT writable"; fi
  else
    parent="$(dirname -- "$dir")"
    if [ -d "$parent" ] && [ -w "$parent" ]; then
      out "    $dir: absent, parent writable (can be created)"
    else
      out "    $dir: absent, parent NOT writable"
    fi
  fi
done

section "3. Language runtimes and shell"
probe_cmd python3 python3 --version
probe_cmd python python --version
probe_cmd sh
probe_cmd bash bash --version
out ""
out "Is /bin/bash present? (only relevant if a candidate needs bash)"
probe_file "/bin/bash" "/bin/bash"

section "4. BusyBox (primary server candidate)"
probe_cmd busybox busybox --help
out ""
if command -v busybox >/dev/null 2>&1; then
  out "Applet list contains httpd?"
  if busybox --list 2>/dev/null | grep -qx httpd; then
    out "    yes"
  else
    out "    NO — BusyBox is present but has no httpd applet"
  fi
  out ""
  out "busybox httpd --help (this is how its real compiled-in options are discovered):"
  busybox httpd --help 2>&1 | sed 's/^/    /' >>"$REPORT" || true
  out ""
  out "Applets relevant to this deployment:"
  for applet in httpd wget sha256sum tar gzip; do
    if busybox --list 2>/dev/null | grep -qx "$applet"; then
      out "    $applet: present"
    else
      out "    $applet: absent"
    fi
  done
else
  out "BusyBox not found — candidate A is unavailable on this machine."
fi

section "5. Desktop integration tooling"
probe_cmd xdg-open
probe_cmd xdg-settings
probe_cmd xdg-mime
probe_cmd xdg-user-dir
probe_cmd update-desktop-database
probe_cmd gio
out ""
out "Default browser association (read-only queries):"
if command -v xdg-settings >/dev/null 2>&1; then
  out "    xdg-settings get default-web-browser: $(xdg-settings get default-web-browser 2>&1 || echo 'query failed')"
else
  out "    xdg-settings: NOT FOUND"
fi
if command -v xdg-mime >/dev/null 2>&1; then
  out "    xdg-mime query default x-scheme-handler/http:  $(xdg-mime query default x-scheme-handler/http 2>&1 || echo 'query failed')"
  out "    xdg-mime query default x-scheme-handler/https: $(xdg-mime query default x-scheme-handler/https 2>&1 || echo 'query failed')"
else
  out "    xdg-mime: NOT FOUND"
fi
out ""
out "Desktop directory, as the desktop environment itself reports it"
out "(we do not assume \$HOME/Desktop):"
if command -v xdg-user-dir >/dev/null 2>&1; then
  out "    xdg-user-dir DESKTOP: $(xdg-user-dir DESKTOP 2>&1 || echo 'query failed')"
else
  out "    xdg-user-dir: NOT FOUND — Desktop shortcut placement would need another mechanism"
fi

section "6. Target browser"
probe_file "360 browser executable" "$BROWSER_EXE"
out ""
out "Browser profile directory presence (existence only — contents are NOT read):"
if [ -d "$HOME/.config/com.360.browser" ]; then
  out "    \$HOME/.config/com.360.browser: EXISTS"
  if [ -d "$HOME/.config/com.360.browser/Default" ]; then
    out "    \$HOME/.config/com.360.browser/Default: EXISTS"
  else
    out "    \$HOME/.config/com.360.browser/Default: not found"
  fi
else
  out "    \$HOME/.config/com.360.browser: not found"
fi
out ""
out "NOTE: the browser version is NOT probed here. Read it from the browser's own"
out "      'about' page and write it into the result template by hand — a --version flag"
out "      on a vendor Chromium build is not guaranteed to be meaningful."

section "7. Archive and integrity tools"
probe_cmd tar tar --version
probe_cmd gzip gzip --version
probe_cmd sha256sum sha256sum --version
probe_cmd openssl openssl version
out ""
out "Hashing mechanism available for release verification:"
if command -v sha256sum >/dev/null 2>&1; then
  out "    sha256sum (coreutils) — preferred"
elif command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx sha256sum; then
  out "    busybox sha256sum — usable"
elif command -v openssl >/dev/null 2>&1; then
  out "    openssl dgst -sha256 — usable"
else
  out "    NONE FOUND — release verification would have to be skipped or done elsewhere"
fi

section "8. Network and port tooling"
probe_cmd ss
probe_cmd netstat
probe_cmd lsof
probe_cmd fuser
probe_cmd curl curl --version
probe_cmd wget wget --version
out ""
out "Fixed deployment origin under evaluation: http://$CANONICAL_HOST:$CANONICAL_PORT/"
out ""
out "Is TCP port $CANONICAL_PORT already in use?"
PORT_REPORTED=no
if command -v ss >/dev/null 2>&1; then
  hits="$(ss -ltnp 2>/dev/null | grep ":$CANONICAL_PORT " || true)"
  if [ -n "$hits" ]; then
    out "    ss: PORT IN USE"
    printf '%s\n' "$hits" | sed 's/^/        /' >>"$REPORT"
  else
    out "    ss: free"
  fi
  PORT_REPORTED=yes
fi
if [ "$PORT_REPORTED" = no ] && command -v netstat >/dev/null 2>&1; then
  hits="$(netstat -ltnp 2>/dev/null | grep ":$CANONICAL_PORT " || true)"
  if [ -n "$hits" ]; then
    out "    netstat: PORT IN USE"
    printf '%s\n' "$hits" | sed 's/^/        /' >>"$REPORT"
  else
    out "    netstat: free"
  fi
  PORT_REPORTED=yes
fi
if [ "$PORT_REPORTED" = no ]; then
  out "    Neither ss nor netstat is available; port state UNKNOWN."
  out "    The candidate server's own bind attempt is then the authoritative test."
fi

section "9. Summary for the Phase-3 decision"
out "Server candidate A (BusyBox httpd): $(command -v busybox >/dev/null 2>&1 && echo 'binary present' || echo 'UNAVAILABLE')"
out "Server candidate B (python3 stdlib): $(command -v python3 >/dev/null 2>&1 && echo 'interpreter present' || echo 'UNAVAILABLE')"
out "Launcher candidate (xdg-open):       $(command -v xdg-open >/dev/null 2>&1 && echo 'present' || echo 'UNAVAILABLE')"
out "Launcher fallback (360 executable):  $([ -x "$BROWSER_EXE" ] && echo 'present and executable' || echo 'UNAVAILABLE')"
out ""
out "Nothing was installed, started, stopped or configured by this probe."

printf 'Probe complete.\nReport: %s\n' "$REPORT"
