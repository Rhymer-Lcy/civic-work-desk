# Phase-3 Stage-A handoff — state at the target acceptance gate

Authoritative resume point. Written at the gate, before any physical-target evidence exists.
**Phase 3 is not complete and UOS compatibility is not certified.**

## 1. Repository state

|                        |                                            |
| ---------------------- | ------------------------------------------ |
| Workspace              | `F:\CivicWorkDesk`                         |
| Branch                 | `audit/phase-3-uos-offline-release`        |
| RC1.1-producing commit | `ea2dc9955bb94c34c90e3dcd24a68e88e661f75a` |
| Git remote             | none, and none may be added                |
| Working tree           | clean at the commit above                  |

The Phase-2 application baseline is unchanged: no application source, build target, PWA behaviour,
data model or deployment architecture was modified in Phase 3.

**Artifacts under `_review_packages/` (24 archives + 24 checksums) and under `release/` must never be
deleted, renamed, overwritten or wildcard-cleaned.** `docs/review-package-provenance.md` explains
every archive in that directory, including the ones that are not deliverables.

> If a commit later than `ea2dc99` exists on this branch and contains only documentation, the RC1.1
> artifact still corresponds to `ea2dc99` — the packaging script re-stamps `builtAt`, so rebuilding
> would change the archive hash. **Do not rebuild RC1.1 to "refresh" it.**

## 2. Phase status

| Phase                                                   | State                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Phase 1 — data/integrity (incl. 1.1/1.2/1.3/1.3.1)      | signed off                                                                       |
| Phase 2 — product/UX                                    | complete; deliverable `civic-work-desk-phase-2-20260922-012109-c51456361487.zip` |
| Phase 3 Stage A — harness preparation                   | complete                                                                         |
| Phase 3 Stage B — physical validation and final release | **NOT started**                                                                  |

Currently stopped at the mandatory physical-target acceptance gate.

## 3. The RC under test

```
release/civic-work-desk-uos-rc1-1.tar.gz
sha256  d86b4111b5752dc67e2d9ca15b4078930d4bb1c56e53e2a29e690fd81fae4950
sidecar release/civic-work-desk-uos-rc1-1.tar.gz.sha256   (sha256sum -c format)
601,892 bytes · 47 tar entries · 37 files in the inner SHA256SUMS.txt
```

`app/` is byte-identical to the accepted Phase-2 `dist/` except for the bundle-only
`deployment-health.json`. Proven mechanically by `scripts/uos/verify-app-unchanged.mjs`, which runs
inside `scripts/uos/build-rc1-1.sh` _before_ packaging — 23/23 shared files identical against
`dist/`, 24/24 identical against RC1's payload including the health file.

RC1.1 supersedes RC1 (`civic-work-desk-uos-rc1.tar.gz`,
`32326c0607707056a1c095351b06924d80574c96d3ce94837263204b1dca3bc9`), which is retained.

The RC1.1 harness has been reviewed and rehearsed on the development machine; it is ready for
physical testing.

## 4. Known target machine (facts, not assumptions)

UOS Desktop 20 Professional (`VERSION_ID=20`, codename eagle) · loongarch64 · Loongson 3A6000 ·
16 GB · kernel `4.19.0-loongson-3-desktop` · Deepin desktop · ordinary UID-1000 user.

Browser: 360 安全浏览器 13.4.1140.83 (64-bit), Chromium 126.0.6478.251, V8 12.6.228.71.
Executable `/opt/apps/com.360.browser-stable/files/com.360.browser-stable`; profile observed at
`~/.config/com.360.browser/Default`; vendor launch includes `--disable-seccomp-filter-sandbox` and
`--disable-gpu-compositing`.

Present: `/usr/bin/python3` (3.7.3), `/usr/bin/busybox` (1.30.1, includes the httpd applet),
`/usr/bin/xdg-open`. Absent: nginx, lighttpd, darkhttpd, httpd, gio. Intended to run fully offline.

## 5. Non-negotiable constraints

- No Node/npm/dev toolchain on UOS; no Electron/Tauri; no native LoongArch binary or package; no
  container; no backend, cloud, telemetry or Internet dependency.
- **No sudo/root requirement**, at install or at run time.
- Canonical origin fixed at `http://127.0.0.1:8765/`. Never silently switch host or port; an
  occupied port must fail loudly rather than fall back.
- IndexedDB remains the business-data store; canonical JSON backup remains the portable recovery
  mechanism. No business data moves to filesystem JSON/SQLite.
- Never delete, reset, move or clear the 360 browser profile, and never automate browser-data
  clearing.

## 6. Server candidates — neither selected

- **A (primary): BusyBox httpd.** `candidate/busybox/{start-test.sh,stop-test.sh,httpd.conf}`.
  Binds `127.0.0.1:8765` explicitly; `-c` passed only if the conf exists (a build without config
  support would refuse the option); stop acts only on its own PID file after confirming
  `/proc/<pid>/cmdline`; never kills by port. `A:127.0.0.1` + `D:*` in the conf is intentional.
- **B (fallback): Python 3.7 stdlib server.** `candidate/python/server.py`. Explicit MIME map,
  explicit cache headers (`no-cache` for entry/sw/manifest/health, `immutable` for `/assets/*`), no
  directory listing, realpath-bounded paths, loopback-only, `allow_reuse_address` deliberately off
  so an occupied port fails instead of double-binding.

Selection must come from physical UOS evidence. Development-machine behaviour proves the code, not
the target.

## 7. Current external action

RC1.1 has been handed to the physical-machine tester. Awaiting real UOS results.

Expected back:

1. `civic-work-desk-uos-rc1-results-*.txt` (from `scripts/collect-results.sh`);
2. the completed `acceptance/RESULT_TEMPLATE.md` (or `RESULTS.md`);
3. `.runtime/headers-*.txt` (HTTP response evidence incl. traversal probes);
4. the relevant BusyBox and/or Python server logs;
5. browser console output or screenshots **only if** something failed;
6. the qualitative performance observations, and the reboot/persistence result if it was performed.

## 8. Acceptance-harness caveats to apply when auditing results

- **BusyBox logging may omit the request path.** The absence of a full `GET /../…` request line in
  a BusyBox log is therefore **not** evidence of failure and must not be recorded as one. Traversal
  evidence should be taken from the RC1.1 raw-path probe and the per-probe assertions in
  `.runtime/headers-*.txt`.
  The RC1.1 manual's step-6 wording ("日志里**必须**能看到…原始路径") is stricter than this and could
  induce a false FAIL against BusyBox. Correct the wording in Stage B or in an RC1.2 if one is cut;
  do not treat a tester's "未测到" on that row as a server defect without checking the probe
  assertions.
- Why the probe exists at all: plain `curl .../../X` is normalised client-side — measured on the
  development machine, the server received `GET /SHA256SUMS.txt`, while `--path-as-is` delivered
  `GET /../SHA256SUMS.txt`. RC1's traversal check therefore tested nothing.
- Collected result files may mix encodings (byte-concatenated sections); read them as bytes or with
  `errors='replace'`.
- The probe report contains `id` and `$HOME`, so it carries the account name; it self-documents that
  this may be redacted before sharing.

## 9. Resume rule after compaction

When physical results arrive:

1. **First** verify the evidence corresponds to _this_ RC — checksum
   `d86b4111…4950`, bundle id `civic-work-desk-uos-rc1-1`, application commit recorded in `VERSION`
   — and to the target machine in §4. Never reuse earlier probe output as though it tested RC1.1.
2. **Do not start implementing Stage B.** Audit first: BusyBox MIME (especially `.js` and `/sw.js`),
   Service Worker registration, cache/update behaviour, `location.origin`, browser capabilities
   (`crypto.subtle`, IndexedDB, Cache Storage), persistence across restarts, and the traversal
   assertions.
3. Choose BusyBox or Python **only** from measured evidence, and record the evidence behind the
   choice.
4. If the evidence is incomplete or self-contradictory, request only the specific missing
   measurement — do not fill the gap by inference.
5. Stage B may begin only once the gate is genuinely satisfied.

## 10. Prohibitions still in force

Do not claim UOS compatibility. Do not call Phase 3 complete. Do not create the final desktop
launcher, `.desktop` entry, installer or end-user release until physical evidence has been reviewed.

## Appendix — where things live

| Path                                     | What                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| `release/uos-rc1-1/`                     | the RC1.1 bundle (source of the archive)               |
| `release/uos-rc1/`                       | RC1, retained                                          |
| `scripts/uos/probe-target.sh`            | read-only target probe (maintained copy)               |
| `scripts/uos/build-rc1-1.sh`             | RC1.1 packager; verifies payload before packaging      |
| `scripts/uos/verify-app-unchanged.mjs`   | per-file hash comparison of `app/`                     |
| `scripts/uos/lint-shell.mjs`             | deployment static check (`npm run lint:uos`)           |
| `docs/uos-deployment.md`                 | operator-facing deployment explanation (Stage-A state) |
| `docs/uos-target-acceptance.md`          | why the gate exists, what must come back               |
| `docs/uos-release-process.md`            | build → assemble → transfer → accept                   |
| `docs/uos-upgrade-recovery.md`           | upgrade / rollback / uninstall rules                   |
| `docs/phase-3-uos-deployment-handoff.md` | the Phase-2→3 handoff, unknowns list                   |

Development gates (all green at `ea2dc99`): `npm run review:package` runs format, lint, typecheck,
Vitest 330, build, static scan, Chromium E2E 96, Firefox/WebKit 21+1 skipped, a11y 14, npm audit.
`npm run lint:uos` additionally checks the deployment invariants. Note that `npm run test:e2e` does
**not** rebuild `dist/` — always build before an ad-hoc E2E run.
