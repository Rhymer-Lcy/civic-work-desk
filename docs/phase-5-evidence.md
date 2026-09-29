# Phase 5 — closeout evidence

**Date:** 2026-09-29 (UTC+8). **Branch:** `phase-5/product-evolution` on `40c8330`; commits in §11.
**Companion:** the design record, [phase-5-product-evolution.md](phase-5-product-evolution.md).

Unless a figure says otherwise, it was measured on the development workstation during the closeout, from
the commits listed at the end. Where a figure is compared with a "before" value, both sides were measured
in the same session, interleaved.

The closeout had two passes. The first recorded the phase (§1–§4 as first written, kept in §3.2 where
they were superseded). A second, narrow pass then closed three engineering issues that the first had left
open or explained by hand — the 台账 rendering regression (§3.1, §4), the Windows numeric version (§5) and
the UOS archive gate's contract (§1) — and re-ran every gate. An independent review of that branch then
found one remaining navigation defect in the in-page links; its correction is §9, and every gate in §1
was run again after it.

## 1. Gates (final)

| gate                                                            | command                                      | result                                                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format, lint, typecheck, unit + integration, static scan, build | `npm run verify`                             | exit 0: Prettier clean, ESLint 0 warnings, both `tsc` projects clean, **487 tests in 35 files**, static scan PASS over 254 files with 13 rules (self-test first), build |
| E2E, Chromium desktop + mobile                                  | `npm run test:e2e`                           | **154/154 in three consecutive full runs**; retries are 0 outside CI and no test was retried or flaky                                                                   |
| E2E, Firefox + WebKit                                           | `npm run test:e2e:cross`                     | 23 passed, 1 skipped — the WebKit offline-reload test, skipped since `eb4fa43` (2026-09-21) for a reproduced Playwright WebKit limitation                               |
| accessibility (axe)                                             | `npm run test:a11y`                          | 16/16                                                                                                                                                                   |
| Windows Go tests                                                | `npm run test:windows`                       | exit 0; 5 packages pass (`httpserve`, `layout`, `redact`, `release`, `winproc`), 5 have no test files                                                                   |
| user-visible copy                                               | `npm run audit:copy`                         | PASS                                                                                                                                                                    |
| UOS shell and doc lint                                          | `npm run lint:uos`                           | PASS, 129 files                                                                                                                                                         |
| UOS deployment lifecycle (WSL Ubuntu 22.04)                     | `npm run test:uos`                           | PASS, all 20 sections                                                                                                                                                   |
| UOS release archive                                             | `npm run test:uos:archive`                   | **56/56**, the signed-off `-5` verified against its own record (below)                                                                                                  |
| review screenshots                                              | `npm run screenshots` (captures, no asserts) | 5 passed; 33 of 35 captures byte-identical to `d0c6d65`, the two ledger captures differ by 21 and 34 anti-aliased pixels (no layout change) and were recommitted        |

No gate is knowingly red. The one skip is a pre-existing, documented harness limitation. The totals
above are from the run after the review correction (§9); the screenshots were captured in the narrow
closeout, and the correction changes no rendered pixel (the skip link it touches is hidden until focused).

**The archive gate asks the right question now.** Its section 5 used to hash the application files inside
the newest UOS archive against the current `dist/`. For a candidate built from the current tree that is the
right check; for the signed-off `-5` it is not, because Phase 5 changed the shared application on purpose —
so the first closeout pass reported **52/55** and explained the three failures by hand (they passed 55/55
against a build of `40c8330`, whose application source equals `-5`'s recorded `applicationCommit=ad65e8f`).
A development branch should not carry a red gate that needs explaining, so the contract was split
(`ce17b41`):

- a **signed-off** archive, listed in `scripts/uos/signed-off-releases.json`, must be byte-identical to the
  registered SHA-256 (`969a2a74…70e5bf` for `-5`), that digest must be the one the sign-off record quotes,
  and its `VERSION` must name the registered `applicationCommit` and `releaseId`; every other section still
  applies, but parity with today's `dist/` is not asked of it;
- any **other** archive is a candidate and keeps the full parity check against `dist/`;
- a registered file name with any other digest fails — it is never quietly treated as a candidate.

Proved by mutation, each run from the repository against a copy: the `-5` tar re-compressed with identical
contents under its registered name fails (digest, sidecar and the acceptance document's digest all
disagree); the same bytes under an unregistered name fall into candidate mode and fail the three parity
checks; a registry with a changed digest fails both the digest check and the sign-off-record check.

**Not run, deliberately:** `npm run build:windows` and `npm run verify:windows` (which ends in
`build:windows`), because they produce a Windows release artifact.

## 2. Frozen artifacts and the remote

| artifact                                                             | SHA-256 (local file)                                               | matches                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `release/civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz`      | `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf` | its sidecar; `phase-3-final-signoff.md`; the archive registry    |
| `release/windows/CivicWorkDesk-Windows-x64-2026.09.24-rc3-Setup.exe` | `4b8bc1d2d80446f3866d88dc6293446c79a1ef1908c28aa9b710b076bdf71e96` | its sidecar; the Phase-4 record; the GitHub release asset digest |

- The GitHub release `windows-v2026.09.24-rc3` is published as a pre-release (not a draft), with the
  installer asset at 6,894,533 bytes and digest `sha256:4b8bc1d2…71e96`. No newer release exists.
- No tracked file under `release/` changed on this branch (`git diff 40c8330..HEAD -- release` is empty).
- Remote refs before integration: `main` at `fa12b03` and `phase-4/windows-offline-distribution` at
  `40c8330`, as when the phase began; tags `rc1`–`rc3` unchanged. This branch was pushed for independent
  review at `6f327fb` and, after the review correction, at `e254226`. Its integration into `main` is
  recorded in [phase-5-final-signoff.md](phase-5-final-signoff.md).

## 3. Performance at 5,000 work records

Synthetic archive: 5,000 work records, 500 honours and about 3,300 progress notes, seeded. The Phase-5
archive adds a 60 / 30 / 10 per cent three-level hierarchy that consumes no random numbers, so every other
field is identical. Each tree is exported with `git archive` and built separately; the arms run alternately
in one session.

### 3.1 Final measurement (narrow closeout)

**Browser** (Chromium, production build, the perf harness unchanged; five interleaved rounds of
pre-Phase-5 `7a93fa8`, Phase 5 as first closed `2113e41`, and the fix `c8b5a8c`; every sample pooled):

| operation      | n   | pre-Phase-5: median (min–max) | Phase 5 unfixed     | fixed: median (min–max) | fixed vs pre-Phase-5 |
| -------------- | --- | ----------------------------- | ------------------- | ----------------------- | -------------------- |
| switch to 台账 | 15  | 1,594 (1,419–1,800)           | 1,994 (1,637–3,703) | **954 (809–1,008)**     | **−40.2%**           |
| switch to 工作 | 15  | 151 (123–176)                 | 105 (75–294)        | 103 (77–119)            | −31.8%               |
| search         | 15  | 70 (67–79)                    | 88 (75–219)         | 87 (78–117)             | +24.3%               |
| XLSX export    | 10  | 1,042 (949–1,200)             | 1,171 (1,127–1,279) | 698 (635–733)           | −33.0%               |
| reload to 概览 | 25  | 108 (95–143)                  | 106 (100–130)       | 108 (98–129)            | 0.0%                 |

The 台账 interquartile ranges do not overlap: 1,560–1,665 ms before Phase 5, 898–979 ms after the fix. The
first pass's regression is reproduced in the middle arm (+25.1%), and removed: the ledger is now faster
than before Phase 5, without virtualization (§4). XLSX export also got faster, very probably because the
page it re-renders while exporting is half the size; that attribution was not measured separately.

**Domain** (Node; median of 15 after 3 warm-ups; three runs per arm):

| operation                                           | pre-Phase-5 runs (ms)    | fixed runs (ms)    |
| --------------------------------------------------- | ------------------------ | ------------------ |
| relational integrity, 5,500 records                 | 1.42 / 2.52 / 1.51       | 2.36 / 2.54 / 2.46 |
| hierarchy validation alone, 5,500 records           | —                        | 0.96 / 0.97 / 1.08 |
| hierarchy derivation for the ledger, 5,402 rows × 2 | —                        | 2.16 / 2.07 / 2.03 |
| default work list                                   | 106.26 / 106.60 / 107.09 | 5.35 / 4.87 / 5.00 |

The integrity pass costs about 1 ms more (medians 1.51 → 2.46), and the hierarchy validation alone
accounts for about 1 ms of it; it scales like the pre-existing checks (§3.2).

**Search, 70 → 87 ms (about +17 ms, +24%) — accepted as a non-blocking Phase-5 observation.** The query
itself is faster than before Phase 5 (§3.2). The 工作 page, which shows 30 cards per page in both versions,
builds a bigger DOM for the same 747 matches: 116 nodes per card instead of 91 (level, parent path and
hierarchy actions) and about 265 more nodes outside the cards (the month calendar), 3,667 against 2,772 in
all. The cost is presentation work for a fixed page of 30 results; it does not grow with the 5,000-record
archive, and the absolute latency stays small. Changing the interface further is not justified by this
evidence, so nothing was optimised; the review accepted the observation as it stands.

### 3.2 First measurement (superseded where stated)

Two runs per side, the same harnesses, taken in the first closeout pass.

| operation            | before (ms) | after (ms) | change   |
| -------------------- | ----------- | ---------- | -------- |
| default work list    | 108.56      | 4.92       | −95%     |
| search (domain)      | 10.51       | 4.73       | −55%     |
| open-status filter   | 16.11       | 1.09       | −93%     |
| urgency sort         | 12.28       | 8.29       | −32%     |
| follow-up list       | 2.60        | 2.74       | +5%      |
| period summary       | 2.36        | 2.60       | +10%     |
| relational integrity | 1.42        | 2.59       | **+82%** |

The design record's "before" table (§13) was taken in an earlier session, where follow-up and summary read
2.1–2.2 and 1.8–1.9 ms. Against it, the first "after" runs (2.68–2.80 and 2.53–2.60 ms) looked 22–33% and
33–44% slower. Interleaved, they are within 10%, and the summary code (`src/domain/reports.ts`) did not
change at all. The earlier gap was session drift. The integrity increase is the hierarchy validation, which
from 5,500 to 22,000 records (4×) grew 5.32× against 5.33× for the rest of the pass, on medians of three
runs.

| operation      | before (ms)   | after (ms)    | change   |
| -------------- | ------------- | ------------- | -------- |
| reload to 概览 | 106 / 104     | 104 / 113     | +3%      |
| switch to 工作 | 152 / 150     | 105 / 74      | −41%     |
| search         | 69 / 71       | 83 / 81       | +17%     |
| switch to 台账 | 1,614 / 1,605 | 2,065 / 1,943 | **+25%** |
| XLSX export    | 1,164 / 991   | 1,152 / 1,217 | +10%     |

Change was computed on the mean of the two runs. The 台账 line — about 1.61 s before Phase 5 and 2.00 s
after — is the finding that prompted the fix in §4: the hierarchy computation took 2.1–2.2 ms, and the rest
was rendering the added cell and card fields on a page that rendered all 5,402 rows twice. The search line
read +17% on two runs; §3.1's fifteen samples put it at +24%.

## 4. The ledger renders one presentation

`c8b5a8c`. The ledger chooses between its table and its card list with `useMediaQuery(LEDGER_TABLE_QUERY)`
— `(min-width: 60rem)`, from `src/styles/breakpoints.ts` — and renders only the chosen one. The hook reads
`matchMedia` synchronously through `useSyncExternalStore`, so the first render is already in the right mode
and nothing is built twice to find out; listeners are removed on unmount and when the query changes.
Printing always takes the table: `usePrinting` flips on `beforeprint` (flushed synchronously, so the table
is committed before the browser lays out the page) and on print-media emulation. The ledger stylesheet no
longer switches presentations at all. The data preparation is unchanged and shared.

Structural proof, not timing — `tests/e2e/ledger-presentation.spec.ts`, 1,000 synthetic work records
(1,083 live records in the ledger):

| case                                          | asserted                                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| desktop 1440×900                              | 1,083 table rows, one table, no list items                  |
| phone 390×844                                 | 1,083 cards; no table, no `tr`, no element with role `row`  |
| 960 px / 959 px                               | table at exactly 60rem, cards one pixel below               |
| live resize 1440 → 390 → 1440                 | the presentation swaps; the other is never added            |
| a `beforeprint` event at phone width          | 1,083 rows and no cards, read in the same task as the event |
| print media at phone width, then screen again | table only, then cards only                                 |

Before the fix was built into `dist/`, the same spec failed on the previous build, finding the 1,083 hidden
cards on desktop — the defect it guards against, caught for real. The unit guards (`use-media-query`,
`breakpoints`) were mutation-tested: removing the synchronous flush, removing the listener cleanup,
re-adding `display: none` or the 60rem rule to the ledger stylesheet, or moving the application bar's
breakpoint each turns a test red.

## 5. Windows numeric version

`e0ff1a9`. `generate-winres.mjs` used to split `${version}.0` on dots and take `parseInt(part) || 0` of each
piece, so `0.2.0-rc.1` became the PE version `0.2.0.1` and no input was ever rejected; `build-release.mjs`
passed the unparsed string to Inno Setup's `VersionInfoVersion`. Both now take `windowsVersion` from one
fail-closed parser, `scripts/windows/product-version.mjs`: `0.2.0`, `0.2.0-rc.1`, `0.2.0-beta.7` and
`0.2.0-alpha.12` all give `0.2.0.0`, `1.12.3` gives `1.12.3.0`, and build metadata, four-part numeric input,
leading zeros, empty identifiers, whitespace and fields above 65535 are rejected with the reason.
`build-release.mjs` parses before any step runs, and the installer script's stale `"0.1.0"` fallback became
an `#error`. `tests/unit/product-version.test.ts` (33 tests) decodes the version resource the build writes
and checks both the binary and the text fields; reinstating the old conversion, accepting four-part input
or accepting build metadata each fails it. Nothing was built.

## 6. Trashed hierarchies can always be removed

The repository refuses to purge a record that something still names as parent. That never strands a
trashed tree, and the tests now walk every way out for 一级 → 二级 → 三级 trashed as one batch
(`aae4bcd`):

- **through the interface** (`tests/e2e/hierarchy.spec.ts`): deleting the root row purges the whole tree and
  says so first; deleting leaf first, one record at a time, empties the trash; 清空回收站 removes the whole
  tree at once — each ends with 回收站是空的;
- **at the repository** (`tests/integration/work-hierarchy.test.ts`): single purges of the root and the
  child are refused and change nothing, then grandchild → child → root succeed with a valid state after
  each; a middle subtree can be purged while its parent stays in the trash, which then goes on its own.

The Trash never offers a single purge of a record with descendants: its confirmation switches to the
subtree purge and states the count. Nothing is detached to make a purge pass. Disabling the
named-as-parent refusal makes the repository tests fail.

## 7. Data invariants, re-confirmed

| invariant                                                             | evidence                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| schema v1 block unchanged                                             | `db.version(1).stores({...})` is byte-identical at `40c8330` and HEAD (252 characters)                      |
| v2 migration deterministic; legacy tasks → `null`                     | `schema-v2-migration.test.ts`: ordinary v1 archive, empty database, invalid rows, reopening changes nothing |
| depth ≤ 3; no self-parent, cycle or dangling parent; no honour parent | `hierarchy.test.ts` (validator and move/create rules); write-boundary refusals in `work-hierarchy.test.ts`  |
| projected merge validates the whole tree                              | `hierarchy-import.test.ts`: cycle, level 4, dangling child, commit-time re-check                            |
| canonical backup restores the hierarchy exactly                       | `schema-v2-backup.test.ts`: "restores every parent link exactly"                                            |
| old backups remain compatible                                         | `schema-v2-backup.test.ts`: schema-1 files verified as received, then migrated                              |
| trashing never orphans descendants                                    | `work-hierarchy.test.ts` and §6                                                                             |
| no telemetry or CDN; no request outside the origin                    | static scan PASS (13 rules); `offline-and-privacy.spec.ts` in every Chromium run                            |

## 8. Installed footprint (Windows)

**Measured source.** At the first closeout this workstation held no installation:
`%LOCALAPPDATA%\CivicWorkDesk` contained only `logs\install.log` (1,686 bytes), written by two passing
machine-stage preflights at `2026-09-28T12:12:15-04:00` and not followed by an install. No installer was run
in this phase. The audit therefore uses the RC3 payload — exactly the files the installer copies into
`releases\<id>\` — and the installer's own layout and retention code.

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

## 9. Review correction: in-page links carry a route as their href

**Defect (found in independent review of `6f327fb`).** The pre-Phase-5 correction `e1b5d7e` made an
ordinary click on the skip link or a Settings index item jump in place, but the anchors still carried raw
fragments (`#main`, `#settings-data`, …) as their real `href`. Every activation the component leaves to the
browser — Ctrl/Cmd-click, middle-click, "open in new tab", a copied link — followed that fragment, which
the router reads as an unknown route and answers with 概览. Reproduced before the fix on the unfixed
build: five new tests failed, with index hrefs of `#settings-app`, fresh and new-tab openings landing on
`#/dashboard`, and a skip-link href of `#main`.

**Correction.** `InPageLink` takes a required `href` typed `RouteHref` (`` `#/${RouteId}` ``, the return
type of `routeHref`), so a section id no longer compiles as an href; `targetId` remains the in-page jump
target. The Settings index passes `routeHref('settings')` and the skip link passes `routeHref(route)` for
the route it is on. An ordinary activation is unchanged: it jumps in place, moves focus, adds no history
entry and leaves the route alone. Every other activation lands on the correct view; the section position is
not encoded in the URL. No second `#` syntax, no History API routing, and section ids do not become routes.

**Tests.** `tests/e2e/in-page-navigation.spec.ts`, 16 → 23 tests on Chromium desktop, all passing after
the fix:

- all eight Settings index items expose `href="#/settings"`, and each, opened in a fresh browser context,
  settles on `#/settings` with the 设置 heading;
- a real Ctrl/Cmd-click (`ControlOrMeta`) and a real middle-click on a Settings index item each open a new
  tab on `#/settings`, while the original tab stays on `#/settings`;
- the skip link's href equals the current route on all six routes (`#/dashboard`, `#/work`, `#/honors`,
  `#/ledger`, `#/reports`, `#/settings`), and each, opened in a fresh context, keeps that route;
- an ordinary section jump and an ordinary skip-link activation leave `history.length` unchanged; the
  earlier pointer, keyboard, focus, scroll and Back/Forward assertions are kept as they were;
- route normalisation is unchanged, now including `#settings-data` and `#main`, which still normalise to
  `#/dashboard`.

`tests/unit/in-page-link.test.tsx` pins the href contract and holds a compile-time check that `#main` is
rejected as an href; widening the prop's type makes that check fail the typecheck.

## 10. Release-engineering backlog before the next Windows build

Recorded here, not implemented in Phase 5 — the Windows release scripts are unchanged by the review
correction. Before the next Windows platform build:

- `scripts/windows/build-release.mjs` must stop defaulting silently to the RC3 release id
  (`arg('--release-id', '2026.09.24-win-rc3')`), and `scripts/windows/generate-winres.mjs` must stop
  defaulting silently to RC2 (`'2026.09.24-win-rc2'`): the release id must be given explicitly, and a
  missing one must fail the build;
- the installer's `AppVersion` and `AppVerName` must use the displayVersion rather than the release id;
- `AppPublisher` and the PE `CompanyName` must use the configured community or store publisher identity,
  as `docs/versioning-and-publisher.md` specifies (`Rhymer-Lcy` for community builds; the store identity
  stays unresolved until it exists).

## 11. Commits

Phase 5: `82c01d0` `e1b5d7e` `7a93fa8` `37a65c2` `581df72` `45674c3` `546c01c` `54863f4` `e882cc1`
`f86bc73` `107e189` `74a54ef` `fb60c33` `0180178` `cbccff0` `e0494ec` `ce85f1c` `d0c6d65` `2b76674`
`ae88afb` `7703b30` `8cb0f02` `02c68a0` `7cb2e6c` `d48e8b9` `2113e41`.

Narrow closeout: `c8b5a8c` (ledger renders one presentation), `e0ff1a9` (Windows numeric version),
`ce17b41` (UOS archive gate contract), `aae4bcd` (trashed-hierarchy purge tests), `afa43ec` (ledger
screenshots), `0f361a0` and `6f327fb` (this record and the design-record notes).

Review correction: one commit — the in-page link href contract, its tests and these records.
