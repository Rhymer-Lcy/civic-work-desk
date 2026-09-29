# Phase 5 — Product Evolution: final sign-off

**Date:** 2026-09-29 (UTC+8). **Branch:** `phase-5/product-evolution`. **Scope:** the shared application
and its data model. This is a product sign-off, not a platform release.

Detail lives in the design record, [phase-5-product-evolution.md](phase-5-product-evolution.md), and the
evidence, [phase-5-evidence.md](phase-5-evidence.md). This record states what was signed off and on what
basis.

## Heads

| head                         | commit                                     | what it is                                                               |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| product and code review head | `e2542263448e3ce4f497952800187c826ec06803` | the reviewed application, including the accepted in-page-link fix        |
| documentation reconciliation | `697098a328c3827fa14a48c1af5afc6445091224` | README, CHANGELOG and current-state docs brought in line                 |
| sign-off                     | the commit that adds this file             | this record, and pointers to it from the README and both Phase-5 records |

**No application code changed after `e2542263`.** Verified at sign-off: every path that differs between
`e2542263` and the working tree is a Markdown file — `CHANGELOG.md`, `README.md`, `docs/data-model.md`,
`docs/migration.md`, `docs/phase-4-windows-rc3.md`, `docs/phase-5-evidence.md`,
`docs/phase-5-product-evolution.md`, `docs/security.md` — plus this new file.

## Versions at sign-off

| concept                     | value         | source                                                                                            |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| database schema             | **2**         | `SCHEMA_VERSION`, `src/db/schema.ts`                                                              |
| backup format               | **3**         | `BACKUP_FORMAT_VERSION`, `src/services/backup/compatibility.ts`; schema-1 archives still readable |
| product development version | `0.2.0-dev.0` | `package.json#version` — a development version, not a release                                     |

## Invariants signed off

| invariant                                                                                                  | where it is proved                                                               |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| the schema-v1 block is unchanged; v1 → v2 migration is deterministic and makes every legacy task top-level | `schema-v2-migration.test.ts`; the v1 block compared byte for byte (evidence §7) |
| depth at most 3; no self-parent, cycle or dangling parent; an honour never parents a task                  | `hierarchy.test.ts`; write-boundary refusals in `work-hierarchy.test.ts`         |
| a merge validates the whole projected tree and is refused whole on any hierarchy issue                     | `hierarchy-import.test.ts`                                                       |
| a canonical backup restores the hierarchy exactly; older backups stay readable                             | `schema-v2-backup.test.ts`                                                       |
| trashing never orphans a descendant; a trashed tree can always be removed                                  | `work-hierarchy.test.ts`, `hierarchy.spec.ts` (evidence §6)                      |
| status and deadlines never cascade                                                                         | design record §6; `hierarchy.spec.ts`                                            |
| JSON is the only canonical backup; XLSX and DOCX are lossy reports that carry hierarchy context            | `export-hierarchy.test.ts`; README                                               |
| the application shell does not move between routes                                                         | `shell-geometry.spec.ts` (0 px at 1366, 1920 and 2560)                           |
| the ledger renders only the presentation in use                                                            | `ledger-presentation.spec.ts` (evidence §4)                                      |
| in-page links jump in place and carry a valid route as their href                                          | `in-page-navigation.spec.ts`, `in-page-link.test.tsx` (evidence §9)              |
| the Windows numeric version never takes a pre-release number                                               | `product-version.test.ts` (evidence §5)                                          |
| a signed-off UOS archive is verified against its own record                                                | `archive-tests.mjs` with `scripts/uos/signed-off-releases.json` (evidence §1)    |
| no telemetry, no CDN, no request outside the application's own origin                                      | static scan; `offline-and-privacy.spec.ts`                                       |

## Measurements accepted at sign-off

- **Ledger.** At 5,000 work records, switching to 台账 takes a median of 954 ms (15 samples), against
  1,594 ms for the pre-Phase-5 build measured interleaved in the same session. The earlier +25% regression
  was removed by rendering one presentation; no virtualization was introduced.
- **Work search, accepted non-blocking observation.** About 70 → 87 ms (+17 ms, +24%): presentation work
  for a fixed page of 30 results, not growing with the archive; the query itself is faster. Not optimised.

## Gates at sign-off

Run on the sign-off tree (the reconciliation commit plus this record's content; no code differs from
`e2542263`):

| gate                                    | result                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| format, lint, typecheck                 | pass (`npm run verify`)                                                                |
| unit and integration                    | 487 tests in 35 files, all passing                                                     |
| static security scan                    | PASS, 254 files, 13 rules                                                              |
| production build                        | pass                                                                                   |
| E2E, Chromium desktop and mobile        | 154/154, no retries (three consecutive full runs at the review correction as well)     |
| E2E, Firefox and WebKit                 | 23 passed, 1 skipped — the WebKit offline-reload test, a documented harness limitation |
| accessibility                           | 16/16                                                                                  |
| Windows Go tests                        | 5 packages pass                                                                        |
| user-visible copy audit                 | PASS                                                                                   |
| UOS lint, deployment lifecycle, archive | PASS (129 files); PASS, all 20 sections; 56/56 against the signed-off `-5`             |

`npm run verify:windows` and `npm run build:windows` were not run: they build a Windows release.

## Release boundary

- **No platform package was produced by Phase 5**: no Windows installer, no UOS package, no store
  package, no tag and no GitHub Release.
- **Windows RC3** is published and unmodified: the installer's SHA-256 is
  `4b8bc1d2d80446f3866d88dc6293446c79a1ef1908c28aa9b710b076bdf71e96`, locally and as GitHub's asset
  digest; it is still a pre-release. Windows compatibility is **not** certified.
- **UOS `-5`** is the signed-off artifact, unchanged: SHA-256
  `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`. No `-6` exists.
- No tracked file under `release/` changed during Phase 5.
- No application-store submission was made, and no store certification is claimed.

## Backlog for the next platform release

Recorded, not implemented (evidence §8 and §10, `docs/versioning-and-publisher.md`):

- the release id must be given explicitly and fail closed — `build-release.mjs` must stop defaulting to
  RC3 and `generate-winres.mjs` to RC2;
- the installer's `AppVersion` and `AppVerName` must use the displayVersion;
- `AppPublisher`, the PE `CompanyName` and copyright must use the configured publisher identity
  (`Rhymer-Lcy` for community builds; the store identity stays unresolved until it exists);
- Windows 10 22H2 x64 needs field evidence on a real machine before the Windows-11-only gate is relaxed
  (`docs/windows-10-legacy-compatibility.md`);
- the Windows installer should keep only the current and previous release directories;
- a UOS candidate must be registered in `scripts/uos/signed-off-releases.json` when it is signed off.

## Integration

`main` is to be advanced to the head that contains this record by a strict fast-forward — no merge
commit, no squash, no rewritten history — provided `origin/main` is still at
`fa12b036901b948fd94caf03d465096b517e50a2`, the merge base of this branch. The resulting commit hashes are
reported outside this file, which cannot name the commit that contains it. The branch is kept for
provenance.

## Sign-off

On the evidence above:

**Phase 5 — Product Evolution: SIGNED OFF.**

This signs off the product for the next platform phase. It is not a platform release and not a
certification of any platform or store.

## Addendum (2026-09-29): post-signoff corrective Phase 5.1

This record is unchanged above this heading. Packaged Windows upgrade acceptance in Phase 6 later
exposed four defects in the signed-off application: the bar moved with a classic scrollbar, applying an
update in one tab reloaded the others, update pages had no view of other open windows, and a page could
not tell that it ran an older interface than the installed program. They are corrected in a separate
corrective phase: [phase-5.1-runtime-update-safety.md](phase-5.1-runtime-update-safety.md).
