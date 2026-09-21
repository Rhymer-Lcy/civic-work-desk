# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is internal and unversioned; entries are grouped by phase.

## [Unreleased] — Phase 1.1 remediation

A narrowly scoped correction pass following an independent audit of the Phase-1 review package. No new
product features, no architectural change, no new runtime dependency. Branch
`audit/phase-1.1-remediation`, on top of `3727a186`.

### Fixed — data safety

- **A replace-mode restore destroyed all data and wrote nothing back.** `buildImportPlan` ignored the
  import mode, so every incoming row was classified as conflicting with the rows the same transaction
  was about to delete: the store was emptied and nothing replaced it. Import now resolves one of three
  explicit strategies from the mode **and** the file format — `merge`, `canonical-restore`,
  `legacy-replace` — and a canonical restore rewrites records, progress, categories, groups and settings
  wholesale inside one transaction. `tests/integration/restore-semantics.test.ts` asserts that the
  restored database equals the backup's payload; all eight of its tests fail against `3727a186`.
- **A legacy file is no longer offered as 完整还原.** It carries no categories, groups or settings, so
  replacing with it keeps the local taxonomy — the dialog and the confirm button now say so.
- **Merge no longer overwrites a progress entry.** Progress was written with `bulkPut`, an upsert, so an
  incoming id colliding with a local one silently replaced the note, and the preview never mentioned it.
  Collisions are now detected, reported with a reason and skipped; every import write uses `bulkAdd`,
  making "never overwrite" a property of the storage call rather than of the plan that precedes it.
- **A backup can no longer silently omit rows it cannot carry.** `createBackup()` refuses with
  `IncompleteBackupError` when a stored row fails validation; Settings offers a diagnostic recovery
  export, proceeding anyway (which records `omittedInvalidRowIds` in the envelope), or cancelling.
- **Backup format and schema versions are bounded at both ends.** A file from a future build is refused
  by name instead of being read because its shape happened to validate; a genuine v1 envelope is
  accepted through an explicit `migrateV1ToV2`.
- **Backup freshness is no longer blind to edits.** Every persisted mutation bumps a `dataRevision`
  counter inside its own transaction, and a backup is stale exactly when that revision has moved.
  Comparing record counts had reported 今天已备份 after an edit, a rename or a new progress note.
- **Record content comparison is a real deep canonical serialisation.** The previous JSON replacer array
  dropped every nested key, so two records differing only in their dates compared identical.
- **An unknown hash now normalises to the route actually rendered.** The guard tested a condition that
  could never be true, so `#/nonsense` showed the dashboard while the address bar named no view.

### Added

- **Diagnostic recovery export** (`src/services/backup/recovery.ts`) — preserves rows that fail
  validation exactly as stored, each with the error that rejected it. Deliberately **not** importable;
  the Diagnostics panel now gives an ordered three-step procedure instead of contradictory advice.
- **Cross-engine test suite** — `tests/e2e/cross-browser.spec.ts`, five critical flows on Firefox and
  WebKit as well as Chromium (`npm run test:e2e:cross`). It found two real defects on its first run.
- **CSP verification that can fail** — an E2E test drives the application under its own policy and fails
  on any `securitypolicyviolation`, then proves the detector works by injecting a real violation.
- Regression suites for restore semantics, import integrity and backup integrity (27 tests), and unit
  suites for the content signature and the router (20 tests).

### Changed — security and build

- **`style-src` is now `'self'`**, with no `unsafe-inline` in any directive. The Phase-1 justification
  for that source was incorrect. The dev server relaxes the directive for itself alone, through a Vite
  plugin that fails loudly if the policy changes shape.
- **`upgrade-insecure-requests` removed.** It made the application fail to load entirely in WebKit over
  plain HTTP from loopback, and bought nothing: every URL the application emits is relative.
- **No source maps in the production build.** `dist/` had carried the complete TypeScript sources.
- **Zod runs jitless**, so it no longer attempts `new Function` on every load and the strict policy
  raises no violation at all.
- **`@types/node` aligned to the 24.x line**, matching the Node 24 runtime the project declares.
- **Playwright never reuses an existing dev server**, so a run cannot silently measure another build.

### Changed — review packaging

- The entry count in `REVIEW_SUMMARY.md` is derived and asserted rather than predicted, and
  `verify-review-package.mjs` reads it back out of the shipped document and compares it with the
  archive's own central directory. Every Phase-1 package understated itself by one entry.
- `TEST_RESULTS.md` reports per-file and per-category counts summed from the captured run, so no
  subtotal is maintained by hand in a document.
- The verifier additionally checks that `TREE.txt` accounts for every packaged payload path, and no
  longer accepts a gateless log as "every gate passed".
- The cross-engine suite is a gate, so the cross-browser claim rests on captured output.

### Note

The original Phase-1 archive was deleted by mistake during this pass and could not be recovered. The
commit it described is intact; `_review_packages/PROVENANCE.md` records what was lost, what replaced it,
and why the replacement is a reconstruction rather than the original.

## [Unreleased] — Phase 1 modernisation

Complete rewrite of the single-file 工作记录台 prototype into a maintainable, testable,
privacy-conscious, installable local-first application. `docs/legacy-audit.md` records the
prototype finding by finding with line numbers; identifiers below (D*, S*, M*, U*) refer to it.

### Added

- **Domain layer** (`src/domain/`) — pure, I/O-free, single implementation of every rule:
  - `DateValue` tagged union (`absent` / `plain` / `range` / `text`) preserving legacy dates
    losslessly, with date-only local arithmetic throughout;
  - canonical `WorkStatus` enum with explicit legacy-label mapping;
  - one `evaluateDeadline()` that names which of the two deadlines drove its verdict;
  - one `runQuery()` for all search, filtering and sorting;
  - report period construction and `summarise()` derived from canonical status.
- **IndexedDB persistence** via Dexie with explicit versioned migrations, per-mutation
  transactions, and Zod validation on both read and write.
- **Versioned backup envelope** — application id, format version, schema version, timestamp, entity
  counts and a SHA-256 of the canonically-serialised payload.
- **Import pipeline** — parse → validate → normalise → preview → confirm → one transaction, with
  merge/replace modes, conflict reporting, in-file duplicate-id detection and migration warnings.
- **Soft delete** with a recoverable trash; deleted records are retained in backups.
- **Genuine `.xlsx`** via ExcelJS: typed date cells, frozen headers, autofilter, wrapped text.
- **Genuine `.docx`** via the `docx` library, generated from the same content as the preview.
- **Real PWA** — static `manifest.webmanifest`, generated PNG icons including maskable variants,
  Workbox service worker precaching the shell only, and a prompt-style update flow.
- **Storage diagnostics** — persistence grant, usage, quota and last successful backup, with the
  limits of persistence stated rather than implied.
- **Design tokens** (`src/styles/tokens.css`) and a deliberate colour policy.
- **Tests** — 167 Vitest (unit + integration) and 82 Playwright (flows, responsive, offline,
  privacy, accessibility), plus a static forbidden-pattern scan over source and `dist/`.
- **CI** (`.github/workflows/ci.yml`) on Node 24.
- **Review packaging** — `scripts/create-review-package.mjs` captures the real output of every gate;
  `scripts/verify-review-package.mjs` re-opens and verifies the archive independently.
- **Documentation** — architecture, data model, migration, security, UX audit, QA plan,
  dependencies, release checklist, and ADR 0001.

### Changed

- Records reference **stable category and group ids**; renaming no longer orphans them (D25).
- `longTerm` is orthogonal to status; completion always wins (D13).
- `未完成` maps to `todo`, not to the cancelled/postponed bucket (D14).
- Report period membership uses the record's **own date**, not its deadline or a coerced
  `createdAt` (D10, D11).
- Completion counts derive from the canonical status enum, not from "any non-empty label" (D12).
- Progress entries have stable ids and their own store; index addressing is gone (D24).
- Backup health tracks **successful JSON exports only**; a spreadsheet export no longer marks the
  data as backed up (D21), and the reminder is no longer permanently suppressed (D20).
- Download success is reported after the blob is built and accepted, with object URLs revoked on a
  delay rather than on the same tick as the click (D22).
- Clearing all data clears **every** table and preference, then re-seeds (D23).
- Honours have their own view, form and field vocabulary (U3).
- Navigation is six named destinations; exports moved into the views that own them (U1).
- Colour carries intent: brand for identity and the primary action, a distinct danger colour for
  destruction, gold for honours only (U2).
- Destructive actions have proportionate confirmation, including typed phrases for irreversible ones
  (U7).
- The ledger renders as genuinely different markup per breakpoint rather than restyled table cells
  (U5).
- Default product title is `政务工作记录台`; the legacy `（离线版）` suffix described a deployment mode
  this build deliberately no longer supports. Remains user-editable.

### Fixed

- **Contrast**: `--ink-400` measured 3.64:1 (fixed to 5.35:1); the honour button measured 3.45:1
  (fixed to 5.03:1); calendar out-of-month days were dimmed below threshold by opacity.
- **Accessible names**: dialog close buttons no longer shadow body actions; required markers and
  field hints no longer inflate control names.
- **Error messages**: `DatabaseError` now carries the underlying cause's message instead of
  replacing it with "operation failed".
- Two independent filter implementations that disagreed about years, months and searched fields
  (D16); five call sites computing "overdue" three different ways (D15).
- Import could create duplicate primary keys from one file, and dropped conflicting records without
  reporting them (D17, D18).
- Derived state recomputed on every load and persisted only by accident (D19).

### Removed

- **Tencent Beacon analytics** (`beacon.cdn.qq.com`) and its inline page-view call (S1). Zero
  third-party telemetry is now enforced by an E2E assertion and a static scan.
- All 178 embedded personal work records and 2 honour records from source (S4). The original file is
  retained outside Git in `_private_reference/`, byte-identical and read-only.
- 118 inline event handlers and 40 `innerHTML` assignments (D2, D3), removing the injection paths
  through record ids (S2) and user-defined category/group names (S3).
- `window.prompt()` flows (D6) and dead code (`exportHonorList`, D7).
- SpreadsheetML served as `.xls` (M1) and HTML served as `.doc` (M2) — the latter also had malformed
  table markup and read four fields that did not exist (M3).
- The runtime blob-URL manifest, which could never satisfy install criteria (M4).
- `downloadSelfFile()`, which could not work in the mode it existed to support (M5).
- `file://` as a supported runtime mode — see ADR 0001.

### Security

- Restrictive CSP with no `unsafe-eval` and no inline scripts; the limits of a meta-tag policy and
  the headers a deployment must add are documented.
- `eval`, `new Function`, `innerHTML`, `dangerouslySetInnerHTML`, `document.write` and inline
  handlers are blocked by lint and by an independent static scan covering `dist/`.
- Six runtime dependencies, all pinned exactly, none loaded from a CDN.
- One accepted moderate advisory (`exceljs` → `uuid`), documented with evidence that the affected
  code path is not reachable.
- No encryption at rest, deliberately — with the reasoning stated rather than the gap left implicit.

### Known limitations

Recorded in full at the end of `docs/qa-plan.md`. In brief: automated testing is Chromium-only;
static JSX accessibility linting is absent pending `eslint-plugin-jsx-a11y` support for ESLint 10;
performance is unverified beyond a few hundred records; multi-tab coherence is untested.
