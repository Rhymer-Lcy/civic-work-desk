# Phase 3 Stage B — evidence and provenance

> **Phase 3 is not complete.** The final installed form has not been validated on the physical
> workstation. Section C below is deliberately empty.

Three kinds of evidence appear in this project, and they are worth very different amounts. This
document keeps them apart, because the expensive mistake is not measuring the wrong thing — it is
carrying a measurement across a boundary where it stopped being true.

| Class | What it is                                                | What it can support                                 |
| ----- | --------------------------------------------------------- | --------------------------------------------------- |
| **A** | RC1.1, measured on the physical UOS workstation           | claims about BusyBox behaviour **on the target**    |
| **B** | Stage B, measured on the Windows/WSL2 development machine | claims about the **deployment logic**               |
| **C** | the FINAL installed form on the physical workstation      | claims that Phase 3 is **done** — not yet collected |

A statement of the form "it works on UOS" may rest only on A or C. Nothing in B can establish it.

---

## A. RC1.1 physical-target evidence

RC (the only one this applies to): `civic-work-desk-uos-rc1-1.tar.gz`, sha256
`d86b4111b5752dc67e2d9ca15b4078930d4bb1c56e53e2a29e690fd81fae4950`, produced by commit
`ea2dc9955bb94c34c90e3dcd24a68e88e661f75a`.

Target: UOS Desktop 20 Professional · loongarch64 · Loongson 3A6000 · 16 GB · kernel
`4.19.0-loongson-3-desktop` · Deepin · 360 安全浏览器 13.4.1140.83 (Chromium 126.0.6478.251,
V8 12.6.228.71) · Python 3.7.3 present · BusyBox 1.30.1 with the httpd applet · `xdg-open` present ·
default HTTP/HTTPS association `com.360.browser-stable.desktop` · operated fully offline.

### A.1 Automated (harness output)

- port 8765 initially free;
- BusyBox httpd present and accepting the required options;
- `/` → `text/html`; entry JS → `text/javascript`; entry CSS → `text/css`; `/sw.js` →
  `text/javascript`; `/manifest.webmanifest` → `application/manifest+json`;
  `/deployment-health.json` → `application/json`;
- `/assets/` directory listing refused with 404;
- traversal probes `/../SHA256SUMS.txt`, `/%2e%2e/SHA256SUMS.txt`, `/..%2fSHA256SUMS.txt` all failed
  to expose the protected file; the raw-path assertions passed.

This is the evidence that selected BusyBox. The MIME result is the load-bearing part: Chromium
refuses a module script served with a non-JavaScript type, and the failure presents as a blank page.

### A.2 Manual (tester-reported observations, not automated logs)

Recorded as reported. These are a person's observations of the RC1.1 candidate, not captured tool
output, and they are labelled that way wherever they are cited.

PASS: `xdg-open` opened 360 Browser · canonical URL `http://127.0.0.1:8765/` · no white screen · no
red console errors · all six primary navigation destinations · create/edit work record · add progress
· create honour · link honour to work · search/filter · ledger · report preview · reload · full
browser close and reopen · local server stop and restart · canonical JSON export · mutate-then-restore
with the restored state matching expectation · XLSX export and local open · DOCX export and local open
· the complete tested workflow offline.

Subjective performance: work list scrolling smooth; ledger scrolling acceptable; report generation
acceptable. Observed application anomalies: none.

**N/A — full workstation reboot.** Not authoritatively confirmed, therefore recorded as not done.
It is not a pass and must not be cited as one.

### A.3 Caveat that must be applied when reading A

**BusyBox httpd may not log the request path.** Absence of a `GET /../…` line in a BusyBox log is
therefore not evidence of failure. Traversal evidence comes from the raw-path probe and its per-probe
assertions, never from log silence.

The RC1.1 manual's step-6 wording ("日志里**必须**能看到…原始路径") was stricter than the server's
behaviour and could have induced a false FAIL. **Corrected in Stage B**: the final acceptance manual
now states that an empty `httpd.log` is the expected and desired outcome, and explains why
(§B.1, item 4). No RC1.2 was cut; the wording was fixed in the artifact that supersedes it.

---

## B. Stage-B development-machine evidence

Host: Windows 11 workstation, Node 24.21.0; POSIX work in WSL2 Ubuntu-22.04 with
**BusyBox v1.30.1 (Ubuntu 1:1.30.1-7ubuntu3.1), x86_64**.

**The boundary, stated precisely.** The applet version matches the target's 1.30.1. The build and the
architecture do not: Ubuntu's x86_64 package against UOS's loongarch64 build. So B can establish that
a command line is accepted, that a script's logic is right, and how _this_ BusyBox behaves — it cannot
establish how the target's BusyBox behaves. Where a B-measurement and an A-measurement cover the same
question, A wins and B is corroboration only.

### B.1 BusyBox behaviour measured here

Four facts the design depends on, each measured rather than assumed:

1. **The document root is resolved once, at startup.** With `-h` pointing through the `current`
   symlink, repointing `current` to another release left the running server still serving the old
   directory. **Therefore a release switch requires a server restart** — this is why the installer
   restarts, why rollback restarts, and why the launcher treats a release mismatch as "restart it".
2. **No `Cache-Control` and no `ETag`.** Responses carry `Content-type`, `Content-Length`, `Date`,
   `Last-Modified`, `Accept-Ranges` and `Connection`. BusyBox httpd has no facility to add headers.
   Consequences are analysed in B.2.
3. **A second bind on the same port fails and the process exits**, with
   `httpd: bind: Address already in use`. So a double-start cannot silently succeed; the port
   pre-check exists to produce a good message, not to prevent a race.
4. **Without `-v`, nothing is logged** — the log file stayed empty across every request. This is how
   the "no request logging" property is obtained: by not passing a flag, not by filtering output.

Also confirmed here: `-c <conf>` is accepted and the MIME table in it takes effect (corroborating A.1
on a different build), and `/assets/` returns 404 with no listing.

### B.2 Cache and update analysis (Phase 3 §8)

BusyBox sends no `Cache-Control`. That is **not** treated as a failure, because the update mechanism
does not depend on one:

- **Fingerprinted assets.** Every JS/CSS bundle carries a content hash in its filename, so a new
  release is a new URL. A stale cache entry for an old URL is harmless — nothing requests it.
- **The service-worker script is not served from the HTTP cache.** `updateViaCache` defaults to
  `'imports'`, under which the browser bypasses the HTTP cache for the top-level worker script. So
  `/sw.js` is revalidated on navigation and a new release is discovered regardless of headers.
- **The application already prompts.** The build uses `registerType: 'prompt'` with
  `skipWaiting: false` and `clientsClaim: false` (see `vite.config.ts`), so a new worker installs,
  waits, and the page offers 「有新版本可用 / 应用更新」. Nothing swaps out from under an open form.
- **`index.html` is served by the worker from precache** after the first visit, so its HTTP freshness
  is not on the critical path.

What is _not_ claimed: nothing here rests on Chromium's heuristic-freshness arithmetic for a response
with `Last-Modified` and no `Cache-Control`. That behaviour is browser-internal and was not measured,
so it is not load-bearing in this design.

**The smallest safe update strategy**, therefore:

1. `install.sh` verifies the new release, activates it, and **restarts the owned server** (required by
   B.1.1);
2. the next page load discovers the new worker and offers the update button;
3. if the browser was open on the old version, the operator clicks 「应用更新」, or closes the tab and
   reopens from the menu.

No step clears Cache Storage, unregisters a worker, or deletes IndexedDB, and the documentation tells
operators not to clear browser data — on this origin that is where the records live.

### B.3 Deployment test suite

`npm run test:uos` → `scripts/uos/deployment-tests.sh`, run in WSL2 against real BusyBox, real
`/proc`, real signals, real symlinks, in a sandboxed `HOME`.

**69 assertions, 69 pass.** The count here is a copy; the suite's own output is the authority. The
suite asserts its own assertion count, so a block that fails to run is a failure rather than a
silently shorter pass. Coverage: install · desktop entry · launch and health gate · repeated launch
idempotence · owned-process detection · port conflict · stale PID and PID reuse · upgrade · health
mismatch after a release switch · rollback · stop · three minimal environments (no `setsid`, and one
HTTP client at a time) · a second upgrade with both pointers already present · uninstall preservation.

`npm run test:uos:archive` → **27 checks, 27 pass**, parsing the delivered tar's bytes.

`npm run lint:uos` → **62 files, PASS**.

### B.4 Two production defects the minimal-environment tests found

Both would have shipped, and both would have presented to the operator as "the application will not
open" with a perfectly healthy server behind it.

1. **`busybox wget -q -T 5 -O - <url>` segfaults.** Measured on BusyBox 1.30.1: exit 139,
   `Segmentation fault (core dumped)`, no output; the identical command without `-T` returns the body.
   The health gate used a per-client timeout flag, so on any machine without GNU curl and without GNU
   wget it would have killed its own probe, reported `no-response`, and refused to open the browser.
   This deployment exists precisely because BusyBox is what the target has, so that is not a remote
   case. **Both** wget branches were affected, because `command -v wget` resolves to BusyBox's wget on
   a BusyBox-centric system. Fixed by removing `-T` and applying `timeout(1)` from outside — one
   implementation for every client instead of four different flags. When `timeout` is absent there is
   no bound, which is the lesser evil: a launcher that waits is recoverable, one that segfaults its
   own health check is not.
2. **An unenumerated dependency on `head`.** `civic_json_field` pipes sed into `head -n 1`. In an
   environment without it the launcher printed `head: not found` and then
   「服务返回的版本信息无法解析」 — a health-gate failure whose stated cause pointed at the _server_.
   `head` is POSIX and present in both coreutils and BusyBox, so the dependency is acceptable; not
   knowing about it was not. The suite now builds its PATH from an explicit dependency list and
   additionally asserts that no run emitted `not found`, so the next missing command is named rather
   than inferred from an exit code.

Two things about how these were found are worth keeping:

- **The bug was in a branch every earlier test had skipped.** 59 assertions passed against the full
  development PATH — curl present, GNU wget present, `setsid` present — none of which the target is
  known to have. Coverage of the happy environment is not coverage.
- **The first attempt to build a minimal environment did not work, and said so.** Masking `setsid` by
  putting a curated directory first on PATH cannot work (`command -v` searches on), and building the
  directory out of BusyBox symlinks cannot work either, because BusyBox's shell exposes every applet
  — including `setsid` — with no PATH lookup at all. Measured: `busybox sh -c 'command -v setsid'`
  answers, `dash` does not. The environment therefore uses the real `/bin/sh` and symlinks to real
  binaries. Had the assertion been written as "we removed setsid" rather than "setsid is absent", the
  section would have tested nothing and passed.
- **Mutation testing found the gap in the fix's own test.** Reintroducing `-T` in the `busybox-wget`
  case passed all 67 assertions, because an environment that provides a `wget` name takes the generic
  branch and never selects it. A third environment — no curl, nothing named `wget` — was added, and
  both mutants are now caught.

### B.5 A defect found only by looking at the generated file

The desktop-entry template carried its rationale as comments, and those comments named the two
placeholders they were explaining. `sed` substituted them, so the **installed** entry read
`# /home/<user>/.local/bin and /home/<user>/.local/share/civic-work-desk are substituted by
install.sh` — a self-contradictory sentence, in a file that lands in the user's menu directory, with
the install path embedded twice more than necessary.

Every structural check passed throughout: Exec absolute, Terminal false, no surviving placeholder,
icon present, target executable. They were all asking about the keys. Nothing was asking what the
file _said_. It was found by installing into a sandbox and reading the result, which is the same
technique that caught a wrong photograph behind a passing review page on another project: render the
artifact and look at it, rather than parsing it.

The rationale now lives in `install.sh` section 7, which is where the substitution happens and the
only place that cannot be rewritten by it.

### B.6 Two defects this work found in its own checks

Recorded because both were invisible while every command reported success.

1. **`lint:uos` was not looking at RC1.1 at all.** `ROOTS` listed `release/uos-rc1`, which does not
   contain `release/uos-rc1-1`, so the twelve RC1.1 files fell outside the scan while the run kept
   printing PASS. Stage A's handoff statement that the lint passed was true and did not mean what it
   appeared to mean. `ROOTS` now names every bundle explicitly and coverage went 17 → 62 files.
   Widening it surfaced three latent rule bugs, all of the "needle too loose" kind and all fixed:
   `[[` matching the POSIX class `[[:space:]]`; `ss\s` matching the "ss " inside "**proce**ss
   holding the port"; and `source` matching the noun in a printed sentence.
2. **The installer reported an activation it had not performed.** Activation wrote the new pointer to
   a temporary name and `mv -f`'d it into place. `mv` resolves a destination that is a symlink **to a
   directory** and moves the source _inside_ it, so `current` never moved — while the installer
   printed `current -> releases/<new>` and exited 0. Fixed with `ln -sfn` (`-n` is the flag that
   makes `ln` replace the symlink itself) plus a read-back assertion, because the defect was
   precisely an unverified print. Both halves are regression-tested, and the test harness had the
   same bug in its own setup, which would have made the health-mismatch section test nothing.

Both fixes were mutation-tested: reintroducing each defect makes a named assertion fail. So was the
ownership rule — dropping the install-prefix condition from `civic_pid_is_ours` initially passed all
every assertion then present, because a foreign server's PID never reaches our PID file on its own.
The suite now plants it there, which is the realistic PID-reuse case, and that mutant is caught.

### B.7 Application payload unchanged

The archive's `app/` is compared file-by-file, **from inside the tar**, against `dist/`: 23 files
byte-identical, one addition (`deployment-health.json`, a deployment artifact written beside the build
so the build itself stays untouched). Verified twice — once by `build-release.sh` before packaging, and
once by `archive-tests.mjs` over the delivered bytes.

### B.8 Rehearsal of the delivered artifact

Everything in B.3 used synthetic four-file bundles. This installs the **real tarball** — real checksum
sidecar, real tar metadata, real 24-file production payload, real inner manifest — in a sandboxed
`HOME` on the POSIX host, and walks the operator's path end to end. **30 checks, 30 pass:**

- `sha256sum -c` on both delivered archives; `install.sh` still executable after extraction;
- install with no `sudo` anywhere in its output, self-check passed, `current` pointing at the release;
- **response types from the real payload**: `/` → `text/html`, the real entry JS → `text/javascript`,
  the real entry CSS → `text/css`, `/sw.js` → `text/javascript`, `/manifest.webmanifest` →
  `application/manifest+json`, `/deployment-health.json` → `application/json`, `/assets/` → 404 with
  no listing. This corroborates A.1 on a different build and on the actual shipped files rather than
  on stand-ins;
- launch opens exactly `http://127.0.0.1:8765/` and nothing else; `status` exits 0 and reports the
  health check passed, naming the release it is serving and the HTTP client it selected;
- the acceptance kit's own `port-conflict-test.sh`, run verbatim: **8 of 8**, including "the process
  holding the port is still alive" and "no browser was opened";
- `collect-results.sh` produces a file that carries the release identity and **does not** contain a
  planted browser cookie value or the contents of a planted backup in `~/Downloads`;
- stop clears the PID file; uninstall removes the program files while the planted backup, the planted
  360 profile and the warning about browser-resident data all survive.

Still class B: same BusyBox applet version as the target, different architecture and build. What it
establishes is that the delivered bytes install, serve and uninstall correctly somewhere real.

### B.9 Stage-B.1 — what an independent artifact audit found

An independent audit of the delivered `2026.09.23-3` pair confirmed the things that were already
right (outer checksums, normalized tar ownership, 35/35 and 5/5 inner manifests, all 23 Phase-2 files
byte-identical, isolated smoke and an 8/8 port-conflict rehearsal) and then found six defects that
those checks could not see. Each is a property of a _sequence_ or a _window_, which is why structural
verification passed over all of them.

| #   | Finding                                                                                                                                                                                              | Disposition                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The acceptance manual ran `collect-results.sh` **after** uninstall, so the strongest automated evidence of the installed form would have been collected from a machine that no longer had one        | Manual and result template reordered: collect while installed, uninstall last, plus a separate post-uninstall checker that writes its own file. A static ordering rule now enforces it, and the rule is checked against the **shipped** manual inside the kit archive as well as the source |
| 2   | `port-conflict-test.sh` left CivicWorkDesk stopped, making the later stop test vacuous                                                                                                               | The script now removes its decoy, restarts the service with `--no-browser`, health-checks it and says so                                                                                                                                                                                    |
| 3   | The installer stopped the server before staging, and `--force` deleted the installed release before the replacement existed — so its own promise that "the previous release keeps running" was false | Rewritten: verify → stage in an owned temporary directory → verify the copy → short activation phase → restart last. `--force` removed entirely                                                                                                                                             |
| 4   | `ln -sfn` activation had given up atomic replacement                                                                                                                                                 | `mv -T` on a same-directory temporary symlink, with `ln -sfn` as fallback and read-back either way                                                                                                                                                                                          |
| 5   | `civic_server_stop` validated ownership once, then sent SIGKILL to the same number ten seconds later — a PID-reuse window                                                                            | Ownership re-proved immediately before every destructive signal, with a start-time identity token; refusal to escalate is reported distinctly rather than escalated                                                                                                                         |
| 6   | README said 「本包只在下列环境上验证」 while VERSION said `targetTested=NO`                                                                                                                          | Split into the two facts: RC1.1 validated the application being served; this installer lifecycle has not been validated on the target. New `installedFormTargetValidated` and `genericPlatformSupportClaimed` fields, asserted by the archive tests                                         |

Two further requirements from the same pass: both delivered archives must be verified before either
is trusted (the kit's own correctness underwrites every result it produces), and the manual must use
absolute `$HOME/.local/bin/...` paths, because `~/.local/bin` is not necessarily on PATH and
"command not found" would read as a product failure.

#### Installer staging and recovery

Failure before activation costs nothing: the active release and the running service are untouched,
because neither is written to until the staged copy has been verified. Failure _during_ activation
has a defined recovery: the release directory is in place but unactivated, and re-running the same
installer detects that, re-verifies the directory and finishes the job without copying again. Failure
_after_ activation — only the desktop entry and the restart can fail there — is reported with the
release already usable, and the same re-run repairs it.

There is no destructive same-release path. A same-id run either resumes an interrupted activation or
refuses and names the directory, because the alternative is deleting the only working copy in order to
replace it.

#### Stop safety

Four facts must hold before a PID is treated as ours: it exists, its command line is a BusyBox httpd
on the canonical host:port, its document root is inside our prefix, and its `/proc/<pid>/stat` start
time equals the value recorded when we started it. The fourth is what makes it identity rather than
resemblance. It is re-checked immediately before SIGKILL; when it fails, the library clears its own
state and returns a distinct status instead of signalling, and both the stop command and the installer
surface that specifically rather than as a generic failure.

Measured here: start time is stable across reads, distinguishes processes started one second apart,
and parses correctly for a process whose name contains a space and a close parenthesis — the case that
breaks the naive left-to-right field split.

#### Launcher lock

The lock is now a symlink whose target is the holder's PID. `mkdir` plus a separate pid file had a
window in which the lock existed with no holder; a grace period would have narrowed it, but a single
atomic operation that carries the holder removes it — the pid-less shape cannot occur. Breaking an
abandoned lock re-reads the holder immediately before removal and requires it to be unchanged, which
is safe rather than merely unlikely: replacing the lock requires removing it first, and any new holder
is a live process whose PID cannot equal the dead one being acted on.

#### Totals after this pass

`npm run test:uos` → **114 assertions**, including fault injection for bundle corruption, staging
failure, staged-verification failure, activation-pointer failure, resume, same-release, `--force`
rejection and desktop-entry failure; PID-reuse before force-kill; and five launcher-lock shapes.
`npm run test:uos:archive` → **51 checks**, now covering both delivered archives. Six mutants — each
fix reintroduced — are caught by the assertion written for it.

#### Rehearsal of the delivered `-4` archives: 53 checks

Run against the real bytes in a sandboxed `HOME`, and this time the upgrade is real: the delivered
`-3` archive is installed first, then upgraded to `-4`, rolled back, and rolled forward. Covered:
both outer sidecars and both inner manifests · clean install · repeated launch with every open at
exactly the canonical origin · a corrupt bundle refused with the running server still serving ·
the real `-3`→`-4` upgrade with both pointers read back · same-release refusal and `--force`
rejection destroying nothing · rollback and roll-forward · stale PID · an identity change before stop
leaving the process unsignalled · an abandoned lock recovered and two simultaneous launches leaving
one server · the kit's own port-conflict script at **10/10 including the service restoration** ·
status/stop/restart · evidence collected before uninstall and containing the release id and a passing
health check, with no planted cookie value or backup content · uninstall preserving the planted
backup and profile · the post-uninstall checker passing and leaving the earlier evidence file
byte-identical.

Two defects in the new post-uninstall checker were found by **reading** that output rather than its
verdict, which was PASS throughout:

- it reported 「0 个文件」 for a downloads directory that demonstrably held a planted backup, because
  `xdg-user-dir DOWNLOAD` falls back to `$HOME` on a machine with no user-dirs configuration, and the
  code only rejected a _missing_ directory, not that one. It was counting the top level of the home
  directory and calling it Downloads;
- the count itself printed as `（0` and stopped, because `grep -c ''` exits non-zero on no match, so
  `|| echo 0` appended a second line and the variable held two.

Both were cosmetic in the sense that nothing was destroyed, and both would have misled the person
reading the returned evidence — which is the only thing that artifact is for.

### B.10 Stage-B.2 — two installer state-machine defects, independently reproduced

An independent audit of the delivered `2026.09.23-4` bytes confirmed the Stage-B.1 work (both
checksums, normalized ownership, both inner manifests, clean install, atomic pointer, launch/health,
repeated launch, status, port conflict 10/10 with restoration, evidence before uninstall, uninstall,
post-uninstall check) and reproduced two defects in the installer's state machine. Both are properties
of a _sequence_, which is why every structural check passed over them.

**1. Two concurrent installers both reported success.** On a clean `HOME`, two installers both saw
`$TARGET` absent, both staged, and the second one's `mv "$STAGE" "$TARGET"` moved its staging
directory **inside** the first one's release — because the destination was by then a directory. Both
exited 0, and `[ -d "$TARGET/app" ]` was still true, so both reported successful activation. The
release tree held `releases/<id>/<id>.<pid>/app/`.

The same `mv` trap as the original pointer bug, one level up: I fixed the pointers with `mv -T` in
Stage-B.1 and left the directory rename on plain `mv`. Fixing a defect in one place is not fixing the
class.

Two independent guards now, because §2 of the brief asked not to rely on the lock alone:

- an **installer lock** — the same primitive as the launcher lock, a symlink whose target is the
  holder PID, so it cannot exist without a holder; a live installer is waited for, anything else is
  abandoned and broken after re-reading the holder;
- a **destination-safe rename** — `mv -T`, which refuses an existing non-empty destination
  ("Directory not empty"), merges nothing and leaves the stage intact. When the destination does
  appear, it is re-inspected and verified against the package manifest: if it is exactly this release
  the run continues as a resume, otherwise it fails without touching it. Never a silent merge.
- and a **shape assertion** — a release directory holds exactly `app`, `runtime`, `VERSION`,
  `SHA256SUMS.txt`. The nested directory is invisible to a manifest check, because every listed file
  is still correct; it is visible to this.

Measured rather than assumed: plain `mv` reproduces the nesting and exits 0; `mv -T` fails with
"Directory not empty" and preserves the stage; BusyBox `mv` rejects `-T` outright, so the fallback
claims the name with `mkdir` (atomic) and moves entries into an empty directory where nothing can nest.

**2. A same-release rerun exited 0 and repaired nothing.** With `current` already naming the release,
the installer printed "already this version" and exited before touching anything — while its own
failure message promised that re-running would restore a missing menu entry. Delete the desktop entry,
re-run the same package, and it stayed deleted.

A same-release run is now a **repair**: verify the installed release against _this package's_
manifest, then reinstate only the deployment integration — shared library, five commands, desktop
entry, directories. It never re-copies or deletes the app tree, never changes the origin, never
touches browser data. It returns 0 only after an integration check confirms the library, all five
commands, the menu entry with the right `Exec`, and the pointer. If the installed release does _not_
match the package, it refuses rather than overwriting in place, and offers three recovery routes that
exist: a new release id, rollback, or an explicit manual deletion of the directory it names.

**3. Recovery instructions pointed at a file the operator did not have.** `install.sh` told the user
to read `docs/uos-upgrade-recovery.md` — a repository path, in no delivered archive. The one message
printed when something had already gone wrong named a file that was not there. The repair procedure
now lives in the shipped `README.md`, and an archive test rejects any `docs/` path in shipped text and
requires every markdown file named by a shipped file to be delivered in one of the two archives. That
test failed against the `-4` bytes when written, which is how it earned its place, and it then caught
a third instance I had missed by hand-grepping: `httpd.conf`.

**4. The README overclaimed.** 「中途任何一步不通过…不会装一半」 is stronger than the design provides.
Rewritten to state the four cases honestly: verification/copy failures leave the active version
untouched; activation is short and read back; **post-activation failures leave a complete, active
release with an integration step failed**, reported explicitly and repaired by re-running the package;
and no failure is ever reported as success.

#### A defect in the test harness, found by these tests failing

`nok()` ended with `[ -n "${2:-}" ] && printf ...`. A failing assertion called _without_ a detail
argument therefore returned 1, `assert` returned 1, and `set -e` aborted the entire suite at the first
such failure — every assertion after it silently never ran. It hid behind the habit of passing a
detail message, and it is why several earlier mutation runs ended "before its summary". A harness whose
failure path can terminate the run reports _some_ of the truth and looks complete. Both helpers now
return 0 explicitly, and the suite reports every failure in one run.

Two harness bugs in the new sections were found the same way: `VAR=x cd dir && sh …` does not export
to the child, so both "concurrent" installers ran against the main sandbox's `HOME` and the section
asserted nothing; and `PATH='…:$PATH'` in single quotes left `$PATH` literal, so the planted-destination
run died with `sh: not found`. Both were visible only because the assertions reported concrete state
rather than an exit code.

#### Totals after this pass

`npm run test:uos` → **138 assertions**, adding: two real concurrent installer processes on a clean
`HOME`; a destination planted between staging and activation by a PATH shim; the four same-release
cases (missing desktop entry — the named reproduction — missing command, damaged payload refused,
healthy rerun idempotent). `npm run test:uos:archive` → **55 checks**, adding the shipped-recovery-
document rule. Four mutants — plain `mv`, plain `mv` with no lock, the early same-release exit, and
plain `mv` with no shape assertion — are each caught by the assertion written for it.

---

## C. Final installed-form physical-target evidence

**NOT YET COLLECTED. Phase 3 cannot be signed off until it is.**

**The candidate is release `2026.09.23-4`**, together with its acceptance kit. Both SHA-256
values and the exact commands are in
`docs/uos-final-acceptance.md`, which is the single place the digests are written — each bound to its
actual archive by a check in `archive-tests.mjs`, so neither can go stale unnoticed, and a digest from
a superseded build appearing there is itself a failure. No digest is copied into this document for
that reason.

Three earlier ids exist in the repository and **none was delivered**. Each was superseded by a real
change, every one of them found by examining the artifact rather than the plan:

| id             | superseded because                                                                  |
| -------------- | ----------------------------------------------------------------------------------- |
| `2026.09.23-1` | the `busybox wget -T` segfault fix (§B.4) changed the runtime                       |
| `2026.09.23-2` | the desktop template had its own explanatory comment placeholder-substituted (§B.5) |
| `2026.09.23-3` | the six defects an independent artifact audit found (§B.9)                          |

Every artifact and every checksum sidecar is kept. The id was bumped rather than reused each time,
so returned evidence can never be matched against the wrong build — four ids in one day is untidy,
and far cheaper than one ambiguous id.

What must come back:

1. the completed `RESULT_TEMPLATE.md`;
2. `civic-work-desk-final-results-<time>.txt` from `collect-results.sh`;
3. the browser-platform JSON (`location.origin`, `'indexedDB' in window`,
   `'serviceWorker' in navigator`, `'caches' in window`, `typeof crypto.subtle`,
   `typeof crypto.randomUUID`, service-worker registration count, Cache Storage keys);
4. the full output of `port-conflict-test.sh`;
5. screenshots **only** for failures.

### C.1 The two gaps that block Phase-3 closure

Neither blocks Stage-B implementation; both block sign-off.

| Gap                                                                      | Status                           | Closes when                                                            |
| ------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------- |
| Full workstation reboot: persistence and launcher behaviour              | **N/A** — not performed in RC1.1 | physically tested, or argued non-blocking under the final architecture |
| Browser-platform evidence: service-worker registration and Cache Storage | **not measured**                 | the browser-platform JSON (item 3 of the list above) is returned       |

Recording these as N/A rather than as passes is the point. No application code was added to expose
those values; they are read once, by hand, in the browser console, and that is stated in the manual.

### C.2 How returned evidence must be audited

1. Confirm it corresponds to **this** artifact — release id, archive SHA-256, and the `VERSION`
   inside the install — and to the target in A. Never reuse RC1.1 output as though it tested the
   installed form.
2. Read the caveat in A.3 before judging any log-based row.
3. Read the collected file as bytes or with `errors='replace'`: its sections are concatenated and may
   mix encodings.
4. If evidence is incomplete or self-contradictory, request the specific missing measurement. Do not
   close a gap by inference.
