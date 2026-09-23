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
(§B.3 below). No RC1.2 was cut; the wording was fixed in the artifact that supersedes it.

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

**59 assertions, 59 pass.** The suite asserts its own assertion count, so a block that fails to run
is a failure rather than a silently shorter pass. Coverage: install · desktop entry · launch and
health gate · repeated launch idempotence · owned-process detection · port conflict · stale PID and
PID reuse · upgrade · health mismatch after a release switch · rollback · stop · a second upgrade with
both pointers already present · uninstall preservation.

`npm run test:uos:archive` → **27 checks, 27 pass**, parsing the delivered tar's bytes.

`npm run lint:uos` → **62 files, PASS**.

### B.4 Two defects this work found in its own checks

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
59 assertions, because a foreign server's PID never reaches our PID file on its own. The suite now
plants it there, which is the realistic PID-reuse case, and that mutant is caught.

### B.5 Application payload unchanged

The archive's `app/` is compared file-by-file, **from inside the tar**, against `dist/`: 23 files
byte-identical, one addition (`deployment-health.json`, a deployment artifact written beside the build
so the build itself stays untouched). Verified twice — once by `build-release.sh` before packaging, and
once by `archive-tests.mjs` over the delivered bytes.

---

## C. Final installed-form physical-target evidence

**NOT YET COLLECTED. Phase 3 cannot be signed off until it is.**

The artifact to test and the exact commands are in `docs/uos-final-acceptance.md`. What must come
back:

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
| Browser-platform evidence: service-worker registration and Cache Storage | **not measured**                 | the JSON in C.3 is returned                                            |

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
