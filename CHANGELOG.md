# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is internal and unversioned; entries are grouped by phase.

## [Unreleased] — Phase 1.3 live-state integrity closure

Making the live database, merges, backups and restores agree on one definition of a valid state. No new
product features, no architectural change, no new runtime dependency, and **no backup format change** —
v3 is unchanged and existing v3 archives remain restorable.

### The primary blocker

**A normal workflow produced a backup the application refused to restore.** Link an honour to a work
record, soft-delete the work record, empty the Trash: Phase 1.2 removed the work record and its progress
and left the honour pointing at a row that no longer existed. Every row still passed its schema, so a
canonical backup was labelled **complete** and recorded as a successful backup — and restoring that same
file was refused for a dangling `relatedWorkId`.

Demonstrated against `48480cf47fc6b9a6f5974de808e39f1576286a46` with a probe written for that API
(`scripts/audit/phase-1-2-live-integrity-probe.test.ts`), where all three assertions fail:

```
AssertionError: the reference must be detached when the work record is purged:
  expected 'test-id-0001' to be null
AssertionError: the snapshot must contain no unresolved honour reference:
  expected [ { id: 'test-id-0002', …(15) } ] to deeply equal []
AssertionError: a file the application labelled complete must be exact-restorable:
  expected [ "备份文件的关联关系不自洽…荣誉引用了文件中不存在的工作记录…" ] to deeply equal []
```

### Fixed — live relational integrity

- **Permanent deletion now detaches, in one transaction.** Purging a work record preserves any honour
  that references it, sets `relatedWorkId` to null, refreshes `updatedAt`, removes the record and its
  progress, and bumps the revision exactly once. Bulk purge does the same for every affected honour. The
  consequence is stated in the Trash confirmation **before** the user commits and reported in the toast
  afterwards — never silent.
- **No mutation path can create a dangling reference.** Creating or editing a record with a nonexistent
  category, group or related work is refused; so is an honour linked to another honour, and a progress
  entry for a record that does not exist. Group deletion already detached its members; category deletion
  already refused while in use — both now verified as part of the same invariant.
- **A soft-deleted record still satisfies a reference**, deliberately: the row exists and is carried in
  backups, so only permanent deletion breaks a link.
- **Taxonomy deletion now discloses the trashed records it affects.** The settings list counts live
  records, but the database counts a trashed one as a user of its category and group. So a category
  used only by trashed records offered a delete the database then refused without saying why, and
  deleting a group detached trashed members with no confirmation at all. Both now state the trashed
  count (`src/features/settings/taxonomy-copy.ts`).

### Fixed — a complete backup is restorable by construction

- **Relational validity is part of backup viability.** `readBackupSnapshot()` validates the live store
  with the same rules a restore applies; a broken state raises `RelationalIntegrityError`, which is
  **not** acknowledgeable — an "incomplete" envelope requires an omission list, and relational damage
  produces none. Diagnostics reports the issues, and the recovery export carries them structured.
- **Backup health no longer infers anything from the live record count.** Phase 1.2 short-circuited to
  `fresh` whenever zero records were visible, which is equally true of a database whose every record is
  in the Trash, or which has custom categories, groups, edited settings, or was emptied after holding
  data. Only a genuinely pristine store (`dataRevision === 0`, never backed up) avoids nagging.

### Fixed — merge evaluates the projected final state

- **A new progress entry for a record the destination already holds now merges.** Phase 1.2 accepted a
  note only when its record was newly imported from the same file, silently skipping the commonest real
  merge there is.
- **A merge can no longer introduce a dangling reference.** An incoming row whose category, group or
  related-work reference would not resolve in `destination + acceptedChanges` is refused with the reason
  stated — never written, never rewritten to null, never resolved by inventing taxonomy. This is also
  what makes an _incomplete_ archive safe to merge.
- Id collisions remain non-overwriting; duplicates never collapse; orphan progress is reported.

### Fixed — semantic validation of v3 metadata

- A v3 envelope claiming `completeness: "complete"` alongside a non-empty omission list — or
  `"incomplete"` with no omission evidence — is **refused**, even with a recomputed, matching digest.
  Checksum integrity is not semantic validity.
- **A destructive legacy replace must have something to write.** A legacy file whose every row is
  unimportable can no longer act as a disguised "wipe my database".

### Changed

- `src/domain/integrity.ts` — one relational-integrity definition over plain arrays, with no knowledge
  of IndexedDB, envelopes or the browser, shared by restore validation, live diagnostics, backup
  viability and the merge planner. Issues are structured (`orphan-progress`, `dangling-category`,
  `dangling-group`, `dangling-related-work`, and the four duplicate-id kinds), not only strings.
- `buildImportPlan` now **requires** the destination's progress, category and group ids. They were
  optional; an omitted list silently meant "the destination has none", which turned a missing argument
  into skipped rows or a raw `ConstraintError` at write time.

### Added

- `tests/integration/live-integrity.test.ts`, `merge-semantics.test.ts`, `backup-health-scope.test.ts`,
  `v3-compatibility.test.ts` — 49 tests covering the twenty mandated regressions.
- `tests/fixtures/phase-1-2-canonical-v3.json` — a v3 archive **generated by the Phase-1.2 build**, so
  compatibility is proven against the previous version rather than against this one's own output.
- `scripts/audit/` — the old-commit probe and the fixture generator, packaged so every supplementary
  claim in the final report can be re-run or inspected. `review/AUDIT_REGRESSION_RESULTS.md` carries the
  captured before/after output.
- One cross-engine workflow covering create work → create linked honour → purge → honour still usable →
  backup succeeds.

### Note — correcting the Phase-1.1 entry below

The Phase-1.1 note says the original Phase-1 archive "could not be recovered". That was true of this
machine at the time; the user has since restored the file from outside this workspace, and it was
verified byte-identical against its recorded SHA-256 rather than assumed. It is present, untouched,
including the `(2)` suffix its download added. `docs/review-package-provenance.md` carries the
verification output. Nothing in `_review_packages/` was renamed, moved or deleted during this pass.

## [Unreleased] — Phase 1.2 backup integrity closure

Closing the remaining backup/restore integrity invariants before the data layer is signed off, after an
independent audit of the Phase-1.1 review package. No new product features, no architectural change, no
new runtime dependency. Branch `audit/phase-1.2-backup-integrity`, on top of `1e0c9cb`.

**Eleven of these were expressed against the Phase-1.1 API and run on commit `1e0c9cb`, where all eleven
fail.** The failure messages, verbatim:

```
incomplete file must not establish freshness: expected 1 to be null
must record R1, not R2: expected 2 to be 1
promise resolved "{ download: …, …(2) }" instead of rejecting        (corrupt category)
promise resolved "{ download: …, …(2) }" instead of rejecting        (corrupt settings)
the omission must be recorded: expected [] to include 'corrupt-group'
exactly one transaction: expected [] to have a length of 1 but got +0
an incomplete archive must be refused for exact restore: expected '' to contain '完整还原'
must refuse to drop a progress row: expected '' to contain '进展 ID'
an orphan must block an exact restore: expected 0 to be greater than 0
the digest must cover completeness metadata: expected 'match' to be 'mismatch'
a v1 file cannot prove completeness: expected undefined to be 'unknown-legacy'
```

### Fixed — completeness

- **An archive that declares itself incomplete can no longer be used for an exact restore.** Phase 1.1
  wrote `omittedInvalidRowIds` into the file and then never consulted it on import, so a file the
  application itself described as incomplete was offered as 完整还原. Completeness is now explicit on the
  file (`completeness`), explicit on the plan (`plan.completeness`, `plan.exactRestorePossible`), and
  enforced by a blocker. Merge remains available; nothing is silently downgraded after confirmation, and
  the confirm button reads 无法完整还原 rather than naming a promise it cannot keep.
- **An incomplete export no longer marks the backup fresh.** `createBackup` called
  `recordBackupSuccess()` regardless of completeness, so a degraded file silenced the reminder. Only a
  complete canonical backup establishes freshness; the diagnostic recovery export and the XLSX/DOCX
  reports never do.
- **Corruption is detected in every user-data store, not only records and progress.**
  `listCategories()` and `listGroups()` filtered failing rows away and `getSettings()` returned
  `defaultSettings()`, so a "complete" backup could drop a corrupt category or ship defaults in place of
  the user's settings with nothing recorded. All five stores are now read through one validated snapshot;
  each of them alone makes the export refuse, Diagnostics reports the damage per store, and the recovery
  export preserves all five raw rows with their reasons. A missing settings row counts as damage rather
  than as absence.

### Fixed — exactness

- **A duplicate progress id now blocks a canonical restore.** Phase 1.1 detected the collision, dropped
  the second row, and still labelled the operation exact.
- **Relational integrity is validated before an exact restore.** An orphan progress entry, a dangling
  `categoryId`, `groupId` or `relatedWorkId`, and duplicate record/progress/category/group ids are each
  refused, with every defect reported at once. The policy is refuse, never repair: dropping the orphan or
  nulling the reference would produce a database that does not match the file.

### Fixed — snapshot coherence and revision accounting

- **The canonical snapshot is one read-only transaction** over records, progress, categories, groups,
  settings and meta. Phase 1.1 used six independent repository reads, so an archive could describe a
  state the database never simultaneously had.
- **The revision a backup records is the revision it captured**, taken inside that transaction. Phase 1.1
  recorded whatever was current when the export finished, so a mutation between snapshot and completion
  was counted as included and the backup read fresh for data the file did not contain. `dataRevision` is
  never rewound to make a file look newer than it is.
- **Freshness compares business dates.** `lastBackupAt` is a UTC instant and `today` is a local day;
  Phase 1.1 compared the instant's first ten characters against the local date, so a seconds-old backup
  reported 「上次备份在 1 天前」 for a whole UTC+8 morning. Found when an E2E assertion of 「今天已备份。」
  started failing purely because the clock crossed 16:00 UTC.

### Changed — backup format v3

- The envelope is **v3**. It carries explicit `completeness`, and its digest covers **the whole envelope
  except the digest itself** — so the completeness metadata that governs what the file may be used for is
  protected. Phase 1.1 hashed `payload` alone, and editing `omittedInvalidRowIds` produced a
  complete-looking archive whose checksum still matched.
- **v1 and v2 remain readable, with explicit migrations.** A v2 file keeps its payload-scoped digest
  (recorded in `checksum.scope`, not recomputed — a digest this build calculated would verify nothing) and
  its completeness is derived. A **v1** file is classified `unknown-legacy`: the format had no
  completeness field and the build that wrote it could drop rows silently, so absence of the field is not
  evidence of completeness. Phase 1.1 migrated it to `omittedInvalidRowIds: []`, which reads as a claim
  the file cannot support. It is still restorable, behind wording that says completeness is unknown.
- The checksum is documented as **corruption detection, not authentication**. There is no key.

### Added

- `src/db/snapshot.ts` — the single-transaction validated read model for every store.
- `src/services/import/integrity.ts` — canonical relational-integrity validation.
- `tests/integration/store-integrity.test.ts`, `backup-freshness.test.ts`, `canonical-exactness.test.ts`
  — 45 tests covering the invariants above.
- Two end-to-end tests driving the incomplete-backup flow through the real UI: the refusal, the knowing
  export, the preview wording, the disabled 无法完整还原 button, and that the reminder stays unsilenced.
- Four more cross-engine flows (edit-and-reload, progress-and-reload, search, offline write) and an
  offline reload, plus a **CI job** that runs the cross-engine suite — Phase 1.1 had wired it into the
  review-package producer but not into CI, so an ordinary PR could regress Firefox or WebKit unnoticed.

### Known limitation

Playwright's WebKit cannot reload an offline page (`WebKit encountered an internal error`, reproduced
2/2). The offline **write** path runs on every engine; the offline **reload** is skipped on WebKit with
that reason declared in the test. Safari and iOS on real hardware remain untested, as in Phase 1.1.

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

The original Phase-1 archive was deleted by mistake during this pass and could not be recovered from
this machine. The commit it described is intact; `docs/review-package-provenance.md` records what was
lost, what replaced it, and why the replacement is a reconstruction rather than the original.
(Superseded in Phase 1.3: the user restored the original from outside this workspace and it was
verified byte-identical. Both files are present.)

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
