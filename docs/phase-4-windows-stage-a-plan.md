# Phase 4 — Windows 11 Offline Distribution: Stage-A plan

> **Windows compatibility is NOT certified.** Nothing in this document is a claim about any Windows
> machine. It is a plan for finding out, and a probe kit for collecting the evidence that would let us
> decide. No Windows release exists.

## 1. What Phase 4 is, and what it is not

**Goal.** An ordinary Windows 11 colleague can install and use CivicWorkDesk locally and offline,
without a development environment: extract or run a setup, launch from the Start Menu, the default
browser opens, it works with no network.

**Not in scope.** No product feature work. No UX change. No data-schema change. Phase 2's application
is the application; Phase 4 is deployment and release engineering only.

**One application.** There is no "UOS app" and no "Windows app". The `dist/` build is shared byte for
byte; only the deployment layer differs. A platform difference that would require a product change is
a signal the deployment design is wrong, not a licence to fork the product.

**The frozen UOS artifact is untouched.** `civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz`,
sha256 `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`, is not modified, rebuilt,
renamed or replaced by any Phase-4 work.

## 2. The invariant that governs every decision

```
http://127.0.0.1:8765/
```

Browser storage is origin-bound: scheme + host + port. A different origin is a different, empty
IndexedDB, which presents to the user as data loss rather than as a configuration difference. So:

- retain `127.0.0.1:8765` unless a **measured** Windows limitation makes it impossible;
- never silently fall back to `localhost`, a random port, a different fixed port, or `file://`;
- an occupied port fails loudly, exactly as on UOS.

`localhost` deserves a specific warning on Windows: it may resolve to `::1` before `127.0.0.1`, and
`http://localhost:8765/` is a different origin from `http://127.0.0.1:8765/` regardless. If a candidate
server binds `::1` only, or the browser prefers it, the user's records appear to vanish. That is a
measurement the probe has to make, not an assumption.

## 3. What is genuinely unknown

Carried over from UOS as _hypotheses_, not findings. The whole point of Stage A is that none of this
transfers by analogy:

| Question                                                             | Why it cannot be assumed                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a non-admin user bind `127.0.0.1:8765`?                          | Loopback binding is normally unprivileged, but Windows has `netsh` URL ACLs, firewall prompts and reserved port ranges (`netsh int ipv4 show excludedportrange`) that can take a port out of play                                                                                                                                                                                                 |
| Does `HttpListener` work without admin on the _colleague_ machines?  | Measured on the development workstation (Win 11 25H2, build 26200, non-elevated): an explicit `http://127.0.0.1:8765/` prefix **succeeded** with no URL ACL present. The URL-ACL requirement applies to wildcard/strong prefixes (`+`, `*`, a hostname), not to a literal loopback IP. Group policy, AppLocker or a hardened image could still change this, so it stays a per-machine measurement |
| Which browser is default, and does it open `127.0.0.1`?              | Edge, Chrome and 360 may all be present; the default association is a per-user setting                                                                                                                                                                                                                                                                                                            |
| Is PowerShell 5.1 present, and is script execution allowed?          | 5.1 ships with Windows 11, but `ExecutionPolicy` and AppLocker/WDAC can block scripts                                                                                                                                                                                                                                                                                                             |
| Are `curl.exe` / `tar.exe` / `certutil` present?                     | All ship with Windows 10 1803+, but a hardened image may remove them                                                                                                                                                                                                                                                                                                                              |
| Does the PWA install, register a service worker, and reload offline? | Chromium on Windows is not Chromium on LoongArch; this is a target measurement                                                                                                                                                                                                                                                                                                                    |

## 4. Candidate local-server mechanisms

Evaluated, not chosen. Stage A collects evidence; the decision is Stage B's, and it must cite
measurements.

### Candidate A — PowerShell + .NET `HttpListener`

Zero bundled binaries; ships with Windows.

**What I expected, and what was measured.** I wrote this section expecting `HttpListener` to fail for a
non-admin user, because `http.sys` requires a URL ACL. Running the probe on the development
workstation (Windows 11 25H2, build 26200, non-elevated, no ACL for 8765) returned **SUCCESS**. The
URL-ACL requirement applies to wildcard and strong prefixes — `http://+:8765/`, `http://*:8765/`, a
hostname — not to a literal `http://127.0.0.1:8765/`. The expectation was wrong and is corrected here
rather than left standing.

That makes Candidate A viable in principle, and it does **not** make it chosen: one machine is one
machine, and a managed corporate image with group policy or AppLocker may behave differently. What
would still eliminate it is a colleague machine where the prefix is denied — and if that happens the
answer is a different candidate, never "run the installer as administrator". The no-elevation
constraint is a product requirement, not a preference.

### Candidate B — PowerShell + raw `TcpListener` (hand-written HTTP)

No `http.sys`, so no URL ACL; an ordinary socket bind on loopback.

**The cost is honesty about what it is:** a hand-written HTTP server is production server code. If this
is chosen it needs adversarial tests before it ships — GET and HEAD, MIME correctness, percent-encoded
and raw traversal, directory requests, malformed request lines, partial reads and split packets,
connection lifecycle and keep-alive, path decoding, index behaviour, shutdown, port conflict. The UOS
work already demonstrated what an untested request path costs: BusyBox's `wget -T` segfault and the
`mv` directory-nesting defect were both found only because something adversarial was pointed at them.

A hand-written parser with no such tests is not a candidate; a hand-written parser with them is.

### Candidate C — a small bundled native static server

A single self-contained executable, run as an ordinary user process.

**Admission criteria, all required:** an identified upstream with a licence compatible with our
distribution; reproducible provenance (source, version, build); a recorded SHA-256; x64 (and a stated
position on ARM64); no installer, no service, no admin; and it must bind only loopback. An opaque
binary from an unidentified source is not admissible whatever its convenience.

### Explicitly rejected for now

**Electron / Tauri.** Both would ship a browser engine to run an application that already runs in the
user's browser, discard the installed-PWA path, and add a large attack and update surface — for a
problem that is "serve twenty-four static files on loopback". `docs/decisions/0001-pwa-first.md`
records the original reasoning. Revisit only if Stage A shows no user-space server can work at all.

## 5. Decision criteria

Stage B picks a candidate by evidence against these, in order:

1. **Works for a non-admin user** on the tested machines. A candidate that needs elevation fails here.
2. **Holds the canonical origin** — binds `127.0.0.1:8765` exactly, never a fallback.
3. **Serves the PWA correctly** — MIME types Chromium accepts for module scripts, no directory
   listing, traversal contained.
4. **Fails loudly** on port conflict, and never terminates a process it has not proven is its own.
5. **Reviewable** — either no third-party binary, or one with licence and provenance on the record.
6. **Simplest thing that satisfies 1–5.** Not the most capable.

## 6. Install layout (proposed, to be confirmed by probe results)

Windows conventions, user-level, no elevation:

```
%LOCALAPPDATA%\CivicWorkDesk\
  releases\<release-id>\app\        the shared dist build
  releases\<release-id>\runtime\    launcher + server + config
  current                           pointer to the active release
  previous                          pointer for rollback
  state\                            pid / ownership token / lock
  logs\                             startup diagnostics only
%APPDATA%\Microsoft\Windows\Start Menu\Programs\政务工作记录台.lnk
```

No `Program Files` (needs elevation), no Windows service, no Scheduled Task unless a need is
demonstrated. Whether `current`/`previous` are directory junctions, `.lnk` files or a small text
pointer is a Stage-B decision — NTFS junction creation does not require elevation for a user-writable
target, but symlink creation historically did, and that difference must be measured rather than
assumed.

## 7. Lifecycle lessons inherited from UOS

These are not re-derivable cheaply; they were each paid for once. They carry over as _requirements_ on
the Windows implementation, while the mechanisms will differ:

- stage into an owned temporary directory, **verify, then activate** — never write into the live release;
- activation must be **destination-safe**: on UOS, plain `mv` moved a staging directory _inside_ an
  existing release and every command reported success. The Windows equivalent needs the same
  property and the same read-back;
- **no destructive same-version overwrite**; a same-version run repairs deployment integration
  (shortcut, commands, state) and never re-copies the app tree;
- a **concurrency-safe installer lock**, because two installers both reporting success is a real
  observed failure, not a theoretical one;
- **process ownership proven before any termination** — on Windows the equivalent of the `/proc`
  cmdline plus start-time token is the PID plus process start time and image path;
- **evidence collected before uninstall**, never after;
- **uninstall removes application-owned files only** — never browser site data, never Downloads.

## 8. Stage-A probe

`deploy/windows/probe/probe-windows.ps1` — read-only, no admin, no configuration change. It writes one
text report the tester returns. It does not install anything and does not start a server it leaves
running.

What it establishes is listed in the script's own header and in
`deploy/windows/probe/README-PROBE.md`. In summary: Windows edition/build/architecture; PowerShell
versions and execution policy; writable user locations and the Start Menu path; presence of
`curl.exe`, `tar.exe`, `certutil`, `Get-FileHash`; installed browsers and the default HTTP association;
port 8765 availability and excluded port ranges; whether a non-admin process can bind loopback with a
raw `TcpListener`; and whether `HttpListener` can register the prefix without elevation.

**Absence is a valid result.** A probe that reports "not present" or "denied" has measured something;
it has not failed.

The browser-side half — service worker, IndexedDB, Cache Storage, Web Crypto, offline reload — cannot
be measured from PowerShell. It needs a page served at the canonical origin, so it belongs to Stage B
after a server candidate exists. Stage A deliberately stops short of it rather than guessing.

## 9. What Stage A does not do

No Windows release. No installer. No shortcut creation. No decision recorded as final. No claim of
Windows compatibility, in any document, until evidence from real machines has been returned and
audited.
