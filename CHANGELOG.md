# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is internal and unversioned; entries are grouped by phase.

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
