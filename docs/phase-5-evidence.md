# Phase 5 — closeout evidence

**Date:** 2026-09-29 (UTC+8). **Branch:** `phase-5/product-evolution` on `40c8330`, not pushed; commits in §5.
**Companion:** the design record, [phase-5-product-evolution.md](phase-5-product-evolution.md).

Unless a figure says otherwise, it was measured at closeout on the development workstation, from the
commits listed at the end. Where a figure is compared with a "before" value, both sides were measured in
the same session, interleaved.

## 1. Gates

| gate                                                            | command                                      | result                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format, lint, typecheck, unit + integration, static scan, build | `npm run verify`                             | exit 0: Prettier clean, ESLint 0 warnings, both `tsc` projects clean, **442 tests in 32 files**, static scan PASS over 247 files with 13 rules (its self-test runs first), production build |
| E2E, Chromium desktop + mobile                                  | `npm run test:e2e`                           | **138/138 in three consecutive full runs**; retries are 0 outside CI and no test was retried or flaky                                                                                       |
| E2E, Firefox + WebKit                                           | `npm run test:e2e:cross`                     | 23 passed, 1 skipped — the WebKit offline-reload test, skipped since `eb4fa43` (2026-09-21) for a reproduced Playwright WebKit limitation                                                   |
| accessibility (axe)                                             | `npm run test:a11y`                          | 16/16                                                                                                                                                                                       |
| Windows Go tests                                                | `npm run test:windows`                       | exit 0; 5 packages pass (`httpserve`, `layout`, `redact`, `release`, `winproc`), 5 have no test files                                                                                       |
| user-visible copy                                               | `npm run audit:copy`                         | PASS                                                                                                                                                                                        |
| UOS shell and doc lint                                          | `npm run lint:uos`                           | PASS, 128 files                                                                                                                                                                             |
| UOS deployment lifecycle (WSL Ubuntu 22.04)                     | `npm run test:uos`                           | PASS, all 20 sections                                                                                                                                                                       |
| UOS release archive                                             | `npm run test:uos:archive`                   | **52/55 on HEAD — expected, see below**; 55/55 against a build of the Phase-4 head                                                                                                          |
| review screenshots                                              | `npm run screenshots` (captures, no asserts) | captured in `d0c6d65`; `src/`, `index.html`, `public/` and `vite.config.ts` are unchanged since                                                                                             |

**The three archive failures are the frozen artifact meeting a newer application, not a defect.**
Section 5 of `archive-tests.mjs` hashes the application files inside the newest UOS archive (`-5`) against
the current `dist/`. Phase 5 changed the application on purpose, so `index.html`, `sw.js` and the hashed
bundles differ (23 files remain byte-identical). To show that nothing else is wrong, the same, unmodified
test was run against the untouched `-5` archive with `dist/` built from `40c8330` — whose application source
is identical to `-5`'s recorded `applicationCommit=ad65e8f` — and with the `-5` acceptance kit beside it
(only the kit's sidecar is tracked in git, so an export lacks it), and passed **55/55**. The check cannot pass on
this branch without rebuilding `-5`, which this phase must not do; it becomes meaningful again when a new
UOS release is cut from the new application.

**Not run, deliberately:** `npm run build:windows` and `npm run verify:windows` (which ends in
`build:windows`), because they produce a Windows release artifact.

## 2. Frozen artifacts and the remote

| artifact                                                             | SHA-256 (local file)                                               | matches                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `release/civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz`      | `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf` | its sidecar; `phase-3-final-signoff.md`                          |
| `release/windows/CivicWorkDesk-Windows-x64-2026.09.24-rc3-Setup.exe` | `4b8bc1d2d80446f3866d88dc6293446c79a1ef1908c28aa9b710b076bdf71e96` | its sidecar; the Phase-4 record; the GitHub release asset digest |

- The GitHub release `windows-v2026.09.24-rc3` is still published as a pre-release (not a draft), with the
  installer asset at 6,894,533 bytes and digest `sha256:4b8bc1d2…71e96`. No newer release exists.
- No tracked file under `release/` changed on this branch (`git diff 40c8330..HEAD -- release` is empty).
- Remote refs are as they were when the phase began: `main` at `fa12b03`, `phase-4/windows-offline-distribution`
  at `40c8330`, tags `rc1`–`rc3` unchanged. The Phase-5 branch exists only locally; nothing was pushed.

## 3. Performance at 5,000 work records

Synthetic archive: 5,000 work records, 500 honours and about 3,300 progress notes, seeded. The "after"
archive adds a 60 / 30 / 10 per cent three-level hierarchy that consumes no random numbers, so every other
field is identical. "Before" is the tree at `7a93fa8`, exported and built separately; the two sides ran
alternately in one session.

**Domain** (Node; median of 15 after 3 warm-ups; three runs per side; the value is the median of the three):

| operation            | before (ms) | after (ms) | change   |
| -------------------- | ----------- | ---------- | -------- |
| default work list    | 108.56      | 4.92       | −95%     |
| search               | 10.51       | 4.73       | −55%     |
| open-status filter   | 16.11       | 1.09       | −93%     |
| urgency sort         | 12.28       | 8.29       | −32%     |
| follow-up list       | 2.60        | 2.74       | +5%      |
| period summary       | 2.36        | 2.60       | +10%     |
| relational integrity | 1.42        | 2.59       | **+82%** |

The design record's "before" table (§13) was taken in an earlier session, where follow-up and summary read
2.1–2.2 and 1.8–1.9 ms. Against it, this session's first "after" runs (2.68–2.80 and 2.53–2.60 ms) looked
22–33% and 33–44% slower. Interleaved, they are within 10%, and the summary code
(`src/domain/reports.ts`) did not change at all. The earlier gap was session drift.

**Browser** (Chromium, production build; each value the median of that run's samples; two runs per side):

| operation      | before (ms)   | after (ms)    | change   |
| -------------- | ------------- | ------------- | -------- |
| reload to 概览 | 106 / 104     | 104 / 113     | +3%      |
| switch to 工作 | 152 / 150     | 105 / 74      | −41%     |
| search         | 69 / 71       | 83 / 81       | +17%     |
| switch to 台账 | 1,614 / 1,605 | 2,065 / 1,943 | **+25%** |
| XLSX export    | 1,164 / 991   | 1,152 / 1,217 | +10%     |

Change is computed on the mean of the two runs.

**The two lines over 20%, investigated:**

- **Relational integrity, +1.2 ms.** The integrity pass now includes the hierarchy validation. Measured
  alone, that validation takes 0.92–0.99 ms (median 0.97) at 5,500 records, and 1.42 + 0.97 = 2.39 ms
  against the measured 2.2–2.6 ms. From 5,500 to 22,000 records (4×), on medians of three runs, the
  hierarchy check grows 5.32× and the rest of the integrity pass 5.33×: the new check scales exactly like
  the checks that were already there. Accepted.
- **台账, +0.4 s — open.** All the hierarchy computation the ledger does (one index build, then level and
  path for every row, twice) takes 2.1–2.2 ms for 5,402 rows. The remaining ~390 ms is rendering one more
  table cell per row and up to two more card fields, on a page that already renders all 5,402 rows twice
  (table and cards) with no windowing. The design record committed to not making this page worse; that
  commitment was not met. The remedy is windowing or rendering one representation, a UX-architecture change
  that this phase deferred. **This is a decision for the product owner**, not a silent acceptance.

## 4. Installed footprint (Windows)

**Measured source.** At closeout this workstation held no installation: `%LOCALAPPDATA%\CivicWorkDesk`
contained only `logs\install.log` (1,686 bytes), written by two passing machine-stage preflights at
`2026-09-28T12:12:15-04:00` and not followed by an install. No installer was run in this phase. The audit
therefore uses the RC3 payload — exactly the files the installer copies into `releases\<id>\` — and the
installer's own layout and retention code.

**One release** (`civic-work-desk-windows-x64-2026.09.24-win-rc3`), 31,189,179 bytes:

| part                                             | bytes      | share |
| ------------------------------------------------ | ---------- | ----- |
| `server\` — four Go executables, 7.2–7.4 MB each | 29,189,120 | 93.6% |
| `app\` — the web application, 24 files           | 1,996,304  | 6.4%  |
| `VERSION` and `SHA256SUMS.txt`                   | 3,755      | —     |

The executables are already built with `-trimpath` and `-ldflags=-s -w`; stripping gains nothing further.

**Installed layout** (`deploy/windows/installer/civic-work-desk.iss`, `civic-admin`):

- `releases\<id>\` — one full payload per release ever installed;
- `bin\` — a **copy** (not a link) of the active release's four executables, 29,189,120 bytes, so shortcuts
  survive the removal of a release directory;
- `logs\` — `server.log` capped at 2 MiB and `install.log` at 1 MiB, each rotated to one `.1` generation;
- `state\`, `current.txt`, `previous.txt` — small;
- Inno Setup's own uninstaller files — not measured here.

**Retention: none on Windows.** No code removes a release directory: `InstalledReleases()` is called only
by `civic-diag` and the launcher's status, and its comment's mention of a "pruning decision" has no
implementation. Every upgrade adds a full payload. The UOS installer, by contrast, keeps the current and the
previous release and removes older ones, printing each removal (`deploy/uos/install.sh`, step 10).

| state                                        | bytes       | MB    |
| -------------------------------------------- | ----------- | ----- |
| one install of RC3 (release + `bin\`)        | 60,378,299  | 60.4  |
| RC1 → RC2 → RC3 upgrades, no pruning (today) | 122,539,370 | 122.5 |
| the same, keeping current + previous only    | 91,552,112  | 91.6  |

Each further upgrade adds about 31.2 MB without bound. **Recommendation for the next packaging phase**, not
implemented here: adopt the UOS rule — after a successful activation, keep `current` and `previous`, remove
older release directories, print what was removed, and never remove the only rollback target. Separately,
merging the four executables into one multi-command binary would remove most of the per-release and
`bin\` duplication; its size must be measured before it is claimed. Nothing was deleted to improve these
numbers.

For comparison, the UOS `-5` payload is 2,088,718 bytes: it ships no native executables.

## 5. Commits

`82c01d0` `e1b5d7e` `7a93fa8` `37a65c2` `581df72` `45674c3` `546c01c` `54863f4` `e882cc1` `f86bc73`
`107e189` `74a54ef` `fb60c33` `0180178` `cbccff0` `e0494ec` `ce85f1c` `d0c6d65` `2b76674` `ae88afb`
`7703b30` `8cb0f02` `02c68a0`, then this record and the design-record corrections it prompted.
