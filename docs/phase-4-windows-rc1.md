# Phase 4 — Windows 11 x64 RC1 (field-validation candidate)

**Status: RC1 built, rehearsed on the development workstation, NOT certified.**

This document records what the Windows RC1 is, how it is built, what was measured, and what is still
unknown. It is written for someone who has to decide whether to hand the installer to a colleague, and
for whoever picks the work up after a field report comes back.

## 1. What was decided, and why the Stage-A probe did not decide it

Stage A produced a read-only probe to characterise colleagues' machines before choosing a local-server
mechanism. That probe was completed and is retained as engineering evidence, but **no colleague ran it**:
the decision was taken to go straight to an installable package instead, so the probe's own results
describe one development workstation and nothing more.

The server mechanism is therefore **not** chosen from probe evidence. It is chosen on grounds that do not
depend on any particular machine:

| Candidate                     | Outcome                                                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — PowerShell `HttpListener` | **Rejected as production.** Works un-elevated on this workstation, but makes the runtime depend on PowerShell execution policy, on AppLocker, and on `http.sys` URL-ACL behaviour — three managed-desktop policies we do not control and cannot test from here. |
| B — PowerShell `TcpListener`  | **Rejected.** Same policy dependency, plus a hand-written HTTP parser, which is the last thing worth hand-writing.                                                                                                                                              |
| C — bundled native binary     | **Selected.** No runtime to install, no script policy to satisfy, a standard-library HTTP implementation, and a deterministic process identity.                                                                                                                 |

Implemented in **Go 1.27.1**, standard library only, cross-compiled to `windows/amd64` with
`CGO_ENABLED=0`. Go is a **build-time** tool, installed as a portable tree at `D:\tools\go1.27.1`; it is
not a target prerequisite and nothing in the shipped package refers to it. Electron and Tauri were not
considered: this is a static file server for seven files.

## 2. The invariant everything else serves

The canonical origin is exactly:

```
http://127.0.0.1:8765/
```

Browser storage is bound to scheme + host + port. A different port is a different origin holding a
different, empty application, and `file://` has no storage at all. So the port is not a setting, there is
no flag to change it, and a conflict on it is a loud failure rather than a fallback. `civic-server` binds
`tcp4 127.0.0.1:8765` and nothing else — never `0.0.0.0`, never `::`, never `localhost` as a substitute,
never a random port.

If the port is occupied, the server exits **3** and the launcher explains in Chinese why it will neither
take the port from another program nor use a different one. **No process is ever killed for holding it.**

## 3. Components

One Go module at [deploy/windows/src/](../deploy/windows/src/) builds four small executables.

| Binary             | Role                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `civic-server.exe` | The static server. Binds the canonical origin, serves `app/`, answers `/__civic/health`.                            |
| `civic-launch.exe` | What the Start Menu shortcut runs. Windows-GUI subsystem, so no console flashes. Also `status`, `stop`, `platform`. |
| `civic-admin.exe`  | Installer/uninstaller side: `preflight`, `activate`, `verify`, `rollback`, `deactivate`.                            |
| `civic-diag.exe`   | One-click diagnostics: writes one txt to the Desktop and opens it.                                                  |

### Serving semantics

Deliberately the same as the BusyBox `httpd` that was field-validated on the UOS target, because
diverging would mean the two platforms serve the same payload differently:

- `/` serves `index.html`; **no SPA fallback** (the application uses hash routing, and BusyBox had none);
- **no directory listing** anywhere, and no implicit index below the root;
- `GET` and `HEAD` only; everything else is `405` with `Allow: GET, HEAD`;
- an **explicit MIME table**, because Go's `mime.TypeByExtension` consults the Windows registry, where
  `HKCR\.js` is routinely `text/plain` — and a module script served as `text/plain` is refused by every
  browser, with the failure remote from its cause;
- `X-Content-Type-Options: nosniff` on everything;
- conditional and range requests via `http.ServeContent`, with the content type set before it can sniff.

**One intentional divergence:** BusyBox sent no cache headers. This server sends
`Cache-Control: no-cache` for `index.html`, `sw.js`, `manifest.webmanifest` and `deployment-health.json`,
and `public, max-age=31536000, immutable` for `/assets/*`. That cannot change correctness — everything
under `assets/` carries a content hash in its filename — and it prevents a service worker script from
being cached hard, which would make updates impossible.

### Path safety

Routing is done by hand rather than with `http.ServeMux`, and that is a security decision. `ServeMux`
normalises the request path and answers a traversal attempt with a `307` to the cleaned path: nothing
escapes, but the refusal never appears in the log and the attempt is silently rewritten into a different
request. Dispatching on the raw decoded path keeps every rejection explicit.

Refused explicitly, each with its own reason: NUL bytes, backslashes, non-absolute paths, `..` segments,
segments ending in a dot or space (Win32 strips those, so `index.html.` would alias `index.html`),
reserved Windows characters, directory requests, and anything whose resolved absolute path is not the
document root or beneath it — checked with a separator, so a sibling sharing a name prefix cannot pass.

**20 traversal shapes** are asserted against the live server, and **25** against the handler in unit
tests, with the canary file proven reachable from its own directory so the battery can fail.

### Process identity and safe stop

A PID is not an identity: PIDs are reused, and "stop the server" becoming "terminate the user's text
editor" is not an acceptable failure. The UOS deployment used `/proc/<pid>/stat` field 22; Windows exposes
the same fact through `GetProcessTimes`, and it is used the same way.

An owned server must satisfy **four facts**: the PID is alive, its creation time equals the recorded
creation time, its image path equals the recorded executable, and that executable lies inside this
installation. Any mismatch is a refusal, and `Terminate` **re-proves all of it through the handle it is
about to kill with**, because the process can exit and its PID be reused between the decision and the
kill.

Stopping is graceful first: a `POST /__civic/shutdown` carrying a token from the user's own state
directory. That is at least as strong a proof of ownership as the PID check — only a process holding our
token honours it — and it is what a second click on 停止服务 uses.

The launch lock is a **file handle opened without write sharing**, not a named mutex. A mutex was written
first and was wrong: mutex ownership belongs to the acquiring _thread_, and the Go runtime moves
goroutines between threads, so a second acquisition from another goroutine succeeded re-entrantly while
the lock was held. A file handle has no thread affinity and the kernel releases it when the process dies
for any reason, so there is no stale-lock state to reason about.

## 4. Installed layout

```
%LOCALAPPDATA%\CivicWorkDesk\
    releases\<release-id>\app\        the PWA payload
    releases\<release-id>\server\     that release's four binaries
    releases\<release-id>\VERSION
    releases\<release-id>\SHA256SUMS.txt
    bin\                              the binaries the shortcuts point at
    state\                            owned-server state and locks; never user records
    logs\                             server.log, install.log
    current.txt                       the active release id
    previous.txt                      the rollback target
```

Two pointer files replace the UOS symlink. Windows can make junctions un-elevated, but a text file written
by rename and then **read back** has no destination-descent hazard at all — which was the defect that cost
Phase 3 a corrective pass, where `mv -f` onto a symlink-to-directory moved the new pointer _inside_ the
old release while the installer printed success.

`bin\` is populated by copy, not link, so the Start Menu shortcut has one stable target across upgrades
and a pruned release cannot leave a dangling shortcut.

**Not used:** Program Files, `HKEY_LOCAL_MACHINE`, a Windows service, a scheduled task, a firewall rule,
the machine-wide PATH, administrator rights. All four are asserted absent in acceptance.

## 5. Installer

**Inno Setup 7.1.0 (x64)**, obtained as a portable tree at `D:\tools\innosetup-7.1.0` (`/PORTABLE=1`, no
machine-wide install). Its licence grants permission to use it "for any purpose, including commercial
applications"; condition 3 invites an acknowledgement without requiring one, and this section is it.

- `PrivilegesRequired=lowest` — no UAC prompt, and no elevation option offered, because nothing here needs
  it and an elevated retry would only hide a real problem;
- `DefaultDirName={localappdata}\CivicWorkDesk`, per-user Start Menu, per-user uninstall key under HKCU;
- `MinVersion=10.0.22000` and `ArchitecturesAllowed=x64compatible`;
- Simplified Chinese throughout (`ChineseSimplified.isl`, not English with overrides).

### Ordering, and why failure is safe

1. **`InitializeSetup`** runs `civic-admin preflight` _before a single file is written_. A blocker shows a
   concise Chinese explanation, writes a full report, and stops. Nothing is installed.
2. **`PrepareToInstall`** stops a server left running by a previous installation, before the file copy.
3. **Files** are extracted into `releases\<id>\` — a new directory, so extraction _is_ the staging step:
   while it runs, `current.txt` still names whatever was working.
4. **`[Run]`** calls `civic-admin activate`, which verifies the payload against its own manifest, refuses
   if the port is occupied, refreshes `bin\`, writes the pointer files with read-back, then **starts the
   server and proves it serves the right release** before returning.
5. **`CurStepChanged(ssPostInstall)`** re-runs `verify`, so a silent activation failure cannot be followed
   by a "finished" page.

A failure at any point before step 4's pointer write leaves the previous version active and usable.

### Preflight replaces the probe for ordinary testers

`civic-admin preflight` checks Windows 11, x64, `%LOCALAPPDATA%` writable, the install root usable, the
per-user Start Menu writable, the release shape, payload integrity both directions, that every payload
file has a known MIME type, that no payload file shadows `/__civic/`, that the bundled server actually
_runs_, and the exact state of port 8765. It uses the same status taxonomy as the Stage-A probe
(`PASS` / `PRESENT` / `NOT PRESENT` / `IN USE` / `INFO` / `FAIL`) so results are comparable.

### Code signing

**The RC1 installer is unsigned.** A signing certificate has not been purchased. SmartScreen may therefore
warn, and the tester instructions say so plainly and tell the reader how to proceed if they choose to —
and explicitly **not** to disable Defender or SmartScreen. Nothing in the package weakens any security
setting.

## 6. Uninstall

`[UninstallRun]` calls `civic-admin deactivate` first, which stops the server and **waits until the
binaries can actually be opened for writing**. That wait is not cosmetic: a process that has exited still
holds its image for a moment, and without it an uninstall leaves an undeletable `civic-server.exe` and a
following reinstall aborts on the locked file — observed, diagnosed and fixed during this rehearsal.

Removed: `bin\`, `releases\`, `state\`, `logs\`, both pointer files, the Start Menu folder, the HKCU
uninstall key.

**Not removed, and said so in a dialog at the moment it matters:** the browser profile, IndexedDB / site
storage, Downloads, JSON backups, XLSX and DOCX exports. Program uninstall is not data deletion.
Reinstalling a compatible version at the same origin makes the records available again — **measured**, not
asserted: see §8, phase 4.

## 7. Diagnostics

Start Menu → 政务工作记录台 → **收集诊断信息** runs `civic-diag.exe`, which writes one UTF-8-with-BOM txt
to the Desktop and opens it: Windows version and build, architecture, machine and account name, default
browser ProgId, install root, active and previous release, installed releases, `bin\` inventory, release
shape and payload verdict, the whole `VERSION` file, port state, health document, recorded process
identity and whether ownership is **provable**, and the tail of the deployment log.

It collects **no** work records, no IndexedDB contents, no browser history, cookies or passwords, and no
exported document contents. The shutdown token is reported as _present_ and never printed — asserted in
acceptance, including that the token's own value does not appear.

`civic-admin` additionally transcripts every run to `logs\install.log`. The installer runs it hidden, so
without that transcript a failed activation is a bare "exit code 5" — which is exactly how the first
failure in this rehearsal presented, and the transcript is what made the second one diagnosable in one
step.

## 8. Development-machine acceptance

Both suites run against the **actual installer bytes**, as an ordinary non-elevated user.

| Suite                                                                                                | Checks | Failed |
| ---------------------------------------------------------------------------------------------------- | ------ | ------ |
| [acceptance-rc1.mjs](../scripts/windows/acceptance-rc1.mjs) — installer, deployment, HTTP, lifecycle | 116    | 0      |
| [acceptance-rc1-browser.mjs](../scripts/windows/acceptance-rc1-browser.mjs) — Chromium at the origin | 63     | 0      |

Covered: sidecar digest match; non-elevated install; clean install; per-user layout; no HKLM / service /
scheduled task / Program Files footprint; Start Menu shortcuts and their target; health gate; exact
origin; default-browser launch; repeated launch idempotent with exactly one server process; MIME for every
payload type; cache-control split; HEAD; 405 for unsafe methods; directory-listing denial; 20 live
traversal shapes; malformed target; `status` proving ownership; a **tampered state file naming a live
unrelated process**, with the refusal explicit and that process verified still alive; stop; double-stop;
stop with no record; port conflict with the occupant surviving and no server started elsewhere;
same-version repair restoring a deleted binary without touching `current.txt`; two concurrent activations
resolving to exactly one success and one `busy`; upgrade; rollback; **a tampered release refused with the
previous version still active**; diagnostics content and privacy.

Browser side, in a persistent Chromium profile: `location.origin`; secure context; IndexedDB; Cache
Storage; Service Worker registered, scoped to root, activated, script from the origin; precache
populated; `crypto.subtle.digest`; `crypto.randomUUID`; records written through the UI and re-read after
reload; JSON backup exported and valid; XLSX exported and its workbook parts parsed; DOCX exported and its
`word/document.xml` parsed and naming the report period; **offline use with the server stopped, records
readable**; uninstall; the browser IndexedDB for the origin surviving it; reinstall; **the records written
before the uninstall still present afterwards**; the exported backup re-imported, with merge correctly
offered as a no-op and 完整还原 restoring to one copy of each record; and zero external network requests in
the entire session.

### Defects found and fixed during the rehearsal

Each was found by the acceptance run and is fixed in the shipped build:

1. **`civic-admin` could not replace itself.** `installBinaries` copies all four binaries, and one of them
   is the running process. Fixed by skipping the copy when the bytes are already identical (the
   overwhelmingly common case, since Setup has just placed them), and otherwise renaming the running image
   aside — a running image cannot be written or deleted, but it can be renamed.
2. **A transient lock made activation fail intermittently.** A just-extracted binary can be held briefly;
   the same command succeeded by hand a minute later. The lock holder was never positively identified, so
   the fix removes the class rather than guessing: the identical-content skip above, plus a retry over 3 s.
3. **`stop` refused when the recorded server was simply already gone**, so a second click produced an
   error. Now a dead record is cleared and reported as "not running".
4. **`stop` returned before the server had exited**, leaving a state file that made the next call look
   wrong. Now it waits for the process and clears the record itself.
5. **Uninstall left a locked `civic-server.exe`, and the next install aborted on it** (exit 5, silent under
   `/SUPPRESSMSGBOXES`). Fixed in three places: `deactivate` waits for the binaries to be releasable;
   `PrepareToInstall` stops a running server and falls back to the freshly extracted `civic-admin` when the
   installed one is already gone; and `stopOwnedServer` can now stop an **orphaned** server whose state
   file was deleted, proving ownership from the health document plus live process inspection.
6. **A named mutex was the wrong lock primitive for Go** — see §3.
7. **A trailing dot was a legal release id**, so `2026.09.24-a.` and `2026.09.24-a` would have been the
   same directory under two names. The pattern now requires an alphanumeric last character.

Seven further failures were defects in the acceptance harness rather than the product, and are recorded
here because each is a reusable trap: a privacy check that matched the report's own disclaimer naming the
things it promises not to carry; a traversal leak-check whose canary string `sibling` was a substring of
the directory name `appsibling`; three assertions that tested a different fact than their names claimed
(all three `Terminate` refusal cases failed for the same unrelated reason until the fixture was staged
properly); expectations that the XLSX ledger and the DOCX statistical summary would contain work-record
titles; and Chinese text read through PowerShell's stdout, which is written in the console code page and
arrived mangled.

## 8a. Reproducibility, stated precisely

The **payload** is bit-reproducible. The application files are copied from the frozen UOS release, and the
four Go binaries are built with `-trimpath -buildvcs=false`, so two builds of an unchanged tree produce an
identical `SHA256SUMS.txt` — verified by building twice and diffing the manifest, not assumed. That
manifest and the release's `VERSION` are tracked under
[release/windows/provenance/](../release/windows/provenance/), so a reviewer can rebuild and compare.

The **installer is not**. Compiling the same payload twice with Inno Setup yields a different `.exe`,
because Setup embeds non-deterministic data. So the installer's SHA-256 identifies **one published
artifact** — it is what a tester checks their download against — and it is _not_ a value a rebuild will
reproduce.

That distinction has a practical consequence, and it bit once during this work: recompiling after the
release replaced the verified published bytes on disk with bytes nobody had checked, and silently rewrote
the sidecar that the release notes quote. The build script now refuses to overwrite an existing installer,
reports the on-disk and recorded digests, and requires `--force-installer` to cut a new one.

## 9. What is NOT established

- **Windows compatibility is not certified.** One machine, one operator, one browser engine.
- No colleague's machine has run this build. Nothing is known about managed-desktop policy, endpoint
  security software, roaming or redirected profiles, or 360 Browser specifically.
- The installer is unsigned; SmartScreen behaviour in the field is unmeasured.
- ARM64 is out of scope for this build and refused by preflight.
- The transient-lock mechanism in defect 2 was never positively identified.

## 10. Reproducing the build

```powershell
node scripts/windows/build-release.mjs --release-id 2026.09.24-win-rc1
node scripts/windows/acceptance-rc1.mjs --keep
node scripts/windows/acceptance-rc1-browser.mjs
```

Needs the portable Go 1.27.1 and Inno Setup 7.1.0 trees (`CIVIC_GOROOT`, `CIVIC_ISCC` override the
defaults). The build verifies the frozen UOS payload against its own manifest before copying `app/`, and
asserts afterwards that every application file is byte-identical to it except the one declared rewrite
(`deployment-health.json`) — so an accidental fork of the application fails the build.

The frozen UOS release is read and never written. Its archive digest is unchanged:
`969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`.
