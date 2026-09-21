# QA plan and results

## Strategy

Three layers, each answering a different question.

| Layer       | Question                                                               | Tool                    |
| ----------- | ---------------------------------------------------------------------- | ----------------------- |
| Unit        | Is the domain logic correct at its boundaries?                         | Vitest                  |
| Integration | Does persistence behave under real transactions?                       | Vitest + fake-indexeddb |
| End-to-end  | Does a user's workflow work in a real browser, against the real build? | Playwright              |

E2E runs against the **production build** served by `vite preview`, not the dev server. The service
worker, the real manifest, the CSP meta tag and the lazy export chunks only exist in a production
build, and three mandatory flows (offline reload, install metadata, external-network assertion) are
meaningless without them.

Tests are written against the legacy defects catalogued in `docs/legacy-audit.md`. Each one names
the defect it guards, so a regression is recognisable rather than merely red.

## Coverage

Every count in this document is quoted from a captured run, and the authority is
`review/TEST_RESULTS.md` inside the review package, whose per-category subtotals are summed from the
per-file lines of the same Vitest run rather than typed by hand. The figures below were taken from the
run of 2026-09-21 that produced the Phase-1.1 package; if a later run disagrees, the package is right
and this file is stale.

### Unit — 153 tests in 8 files

| File                           | Covers                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dates.test.ts`                | leap years, century rule, month lengths, impossible dates, **DST boundaries**, month/year rollover, every legacy date shape, range semantics, window overlap, well-formedness                                                                                                 |
| `deadlines.test.ts`            | urgency classification, earlier-of-two-deadlines with attribution, range judged by its end, closed statuses, deferred still in scope, long-term not suppressing a real date, text-only deadlines, 30-day backlog split, follow-up membership                                  |
| `query.test.ts`                | search normalisation incl. full-width space, searchable fields for both kinds, filter composition, soft-delete exclusion, honours never caught by a status filter, date windows, calendar day selection, sorting with undated records last, option derivation, follow-up list |
| `status-and-reports.test.ts`   | every legacy status label, `未完成`→todo, unrecognised→null, period construction, **membership by the record's own date**, first-of-month boundary, completion rate from canonical status, overdue vs stale separation                                                        |
| `legacy-normalisation.test.ts` | all 20 fixtures against the schema; dates, phones, statuses, progress, honours (both shapes), categories, residue, rejection, id preservation                                                                                                                                 |
| `backup-envelope.test.ts`      | canonical JSON key ordering, envelope self-description, JSON round-trip, checksum match/mismatch/absent, counts consistency, filename sortability, backup-health state machine                                                                                                |

| `record-signature.test.ts` | deep content equality: a nested date, both ends of a range, a free-text date, an honour award date and `legacyResidue` all participate; audit timestamps do not; key order is irrelevant at any depth; the import preview's identical-vs-differing verdict |
| `router.test.ts` | every declared route; unknown, empty, bare, repeated-slash, trailing-slash and capitalised hashes; query retained on a known route and discarded with an unknown one; normalisation idempotence; the invariant that a canonical hash parses to the same route |

The two new files each keep the **defective** Phase-1 implementation beside the corrected one, so an
assertion states what actually regressed rather than testing current code against itself.

### Integration — 63 tests in 5 files

`database.test.ts` — seeding idempotence, CRUD, schema rejection on write, invalid-row reporting on
read, soft delete and restore, purge with progress, trash emptying, progress entries addressed by
**stable id**, category/group rename integrity, deletion guards, settings persistence, backup meta.

`backup-round-trip.test.ts` — export→wipe→restore byte-identical; trash retained in backups;
tampered backup refused; malformed envelope refused; merge never overwrites; identical conflicts
flagged; duplicate ids inside one file rejected; replace destroys and reports; settings adopted only
on replace; locally renamed categories preserved; all three legacy formats; progress carried over;
re-import idempotent.

`restore-semantics.test.ts` — **the P0 suite.** A canonical snapshot of every user-data store must
equal the backup's payload after a restore: from the same backup; after local divergence; with partial
id overlap; with taxonomy, groups and settings restored exactly. Plus transaction rollback on an
injected mid-write failure (nothing written, revision unchanged); `legacy-replace` retaining local
taxonomy; a CivicWorkDesk envelope in replace mode resolving to `canonical-restore`; and merge still
skipping clashes. All eight fail against Phase 1, where a replace-mode restore deleted the store and
wrote nothing back.

`import-integrity.test.ts` — merge never overwrites a destination progress entry, and the preview
matches what is written; a duplicate progress id inside one file is detected and de-duplicated;
adversarial progress rows (null, a number, an empty note, an invalid date) are rejected rather than
written malformed; a canonical restore carries every progress entry. Then the revision invariant: an
edit that leaves the record count unchanged makes the backup stale; a settings change does too; a
rolled-back mutation does not advance the revision; an exact restore leaves the state current rather
than stale.

`backup-integrity.test.ts` — a backup refuses to call itself complete while dropping a corrupt row;
knowingly proceeding records `omittedInvalidRowIds` in the envelope; a clean store declares itself
complete; the diagnostic recovery export preserves the raw invalid rows verbatim with their rejection
reasons; that export is **not** importable; a later known-good restore clears the corruption. Then
compatibility: a future `backupFormatVersion` (999) is refused by name, a future `schemaVersion` too, a
non-numeric version is refused, and a genuine v1 file is accepted through `migrateV1ToV2` and still
restores exactly.

### End-to-end — 75 Chromium + 10 cross-engine + 14 accessibility

**`smoke.spec.ts`** — first run and empty state; create/edit/complete; progress add and edit with
the neighbouring entry verified untouched; long-term visibility and completion precedence; honour
creation and linking; search and filter composition with chips and clear-all; calendar day
selection; ledger; soft delete and restore; cancel-never-mutates including the unsaved-changes
guard.

**`data-safety.spec.ts`** — JSON backup downloaded, parsed, validated field by field, and
re-imported; backup health updates only after a JSON export; import preview writes nothing until
confirmed; free-text date preserved through a real import; `未完成` lands as 待办; corrupted backup
refused with a reason and the button disabled; replace mode demands a typed phrase; **XLSX is a ZIP
container, not `<?xml`**; **DOCX is a ZIP container, not `<!DOCTYPE`**; report completion rate is
50.0% for one-of-two (not 100%); undated records reported as excluded; clearing all data requires a
typed phrase and restores defaults; emptying the trash is separately confirmed.

**`offline-and-privacy.spec.ts`** — no request leaves the origin across every route _including_ both
lazy export chunks; built output free of analytics/CDN/font hostnames; CSP present, restrictive, and
free of `unsafe-eval` and of `unsafe-inline` in **any** directive; manifest valid with maskable icons
and every declared icon resolving; service worker registers; **offline: create → go offline → reload →
records intact → CRUD still works → no external request**; **no user record content in any Cache API
entry**; **no source map shipped** (no `sourceMappingURL` in any served script, and no `.map`
retrievable by guessing its name); and the application **runs under its own strict policy without a
single reported violation** — measured with the `securitypolicyviolation` event, and self-tested at the
end of that test by deliberately injecting an inline `<style>` and failing if it goes unreported.

**`cross-browser.spec.ts`** — the critical flows, run on Chromium, Firefox and WebKit: first-run
seeding and a record surviving a reload (IndexedDB durability); a date-only value rendering as the day
it was entered, tested at 1 January where a UTC round-trip would show 2025-12-31; JSON backup export →
canonical restore → data intact; both lazy export chunks producing real ZIP containers; and keyboard-only
dialog focus trap, Escape, and focus restoration.

**`responsive.spec.ts`** — no horizontal page overflow at 360/390/768/1024/1440 px on all six
routes, with deliberately long Chinese content; ledger becomes a genuine card list (table removed
from the accessibility tree); form single-column with usable control heights; navigation reachable
with `aria-current`; primary action ≥40px on a phone.

**`accessibility.spec.ts`** — axe over nine states; focus trap over 30 tabs; focus restoration;
skip link; keyboard-only record creation; accessible name on every button; 200% zoom.

### Static

`scripts/static-security-scan.mjs` — ten rules over every source file and `dist/`; the scan prints the
file count it actually covered (166 in the run that produced the Phase-1.1 package). Source rules
(inline handlers, `eval`, `new Function`, `dangerouslySetInnerHTML`, `innerHTML`, `document.write`)
apply to our code; egress rules (remote script/link, telemetry hosts, absolute paths, legacy record
ids) apply to the built bundle too. Exceptions are listed in the script with reasons.

## Results

Captured from the run that produced the review package; the raw output is in
`review/VERIFY_LOG.txt`.

| Gate                           | Command                  | Result                                                           |
| ------------------------------ | ------------------------ | ---------------------------------------------------------------- |
| Format                         | `npm run format:check`   | PASS                                                             |
| Lint (`--max-warnings=0`)      | `npm run lint`           | PASS                                                             |
| Typecheck (both projects)      | `npm run typecheck`      | PASS                                                             |
| Unit + integration             | `npm run test:unit`      | **PASS — 216/216** in 13 files (153 unit, 63 integration)        |
| Production build               | `npm run build`          | PASS                                                             |
| Static security scan           | `npm run scan:static`    | PASS — 0 findings                                                |
| E2E, Chromium desktop + mobile | `npm run test:e2e`       | **PASS — 75/75**                                                 |
| E2E, Firefox + WebKit          | `npm run test:e2e:cross` | **PASS — 10/10** (5 critical flows × 2 engines)                  |
| Accessibility (axe)            | `npm run test:a11y`      | PASS — 14/14, 0 unexplained violations                           |
| `npm audit --omit=dev`         | high/critical            | PASS — 0 at `high` or above (2 moderate accepted and documented) |

The desktop-Chromium project runs every spec, so `accessibility.spec.ts` is counted both inside the 75
and again in the dedicated `a11y` project, which re-runs it at 1280×900. That double count is
deliberate and stated rather than netted off.

### Defects found and fixed by this test suite

Worth recording, because a suite that never reports a finding is not being run.

1. **`--ink-400` failed WCAG AA** — `#8b8580` measured 3.64:1 on white against the required 4.5:1.
   Found by axe on the empty dashboard. Fixed to `#6f6a64` (5.35:1 / 4.82:1 on the two surfaces
   secondary text appears on).
2. **The honour button failed WCAG AA** — `--honor-600` with white text measured 3.45:1. Found by
   axe on the honour dialog. Fixed to `--honor-700` (5.03:1).
3. **Calendar out-of-month days failed contrast** — `opacity: 0.55` pushed them below threshold
   while remaining clickable. Opacity removed; de-emphasis now by weight and ink.
4. **`DatabaseError` masked every underlying message** — a repository throwing "category already
   exists" surfaced to the user as "database operation failed: addCategory". Found by an integration
   test. The wrapper now carries the cause's message.
5. **Verbose accessible names** — the required marker and the long-term hint were inside their
   labels, so controls were named "事项 （必填）" and "长期推进事项 仍按状态判定完成；…". Fixed with
   native `required` and `aria-describedby`.
6. **The dialog close button's name was a superset of every body button's name** —
   `aria-label={关闭${title}}` meant a query for "移入回收站" also matched "关闭移入回收站？". Fixed to
   a fixed name; the dialog's own name provides the context.

Three test-harness defects were also found and fixed, recorded here because they would otherwise
read as product findings: axe scanning mid-animation and measuring blended colours; `gotoApp`
failing to wipe IndexedDB because the running application held the connection open; and a test
racing a form field's post-write clear.

### Found during Phase 1.1, by the tests written for it

The Phase-1 suite passed on all of these. Each was found by a new test, or by looking at something no
test had been pointed at:

1. **A replace-mode restore destroyed everything and wrote nothing back** (P0). `buildImportPlan`
   ignored the mode, so every incoming row was classified as conflicting with the rows the same
   transaction was about to delete. Proven with a throwaway run against the Phase-1 commit —
   `PLAN accepted=0 conflicts=2 / APPLY destroyed=2 written=0 / AFTER records=0 progress=0` — and now
   covered by eight tests that all fail against that commit.
2. **Merge silently overwrote a local progress note** whose id an imported file happened to reuse,
   because the write used `bulkPut`. The preview never mentioned it.
3. **A backup silently omitted rows it could not carry**, while Diagnostics told the user to export
   that same backup as evidence before recovering.
4. **Any future backup version was accepted**, because validation asked for `>= 1`.
5. **Backup freshness was blind to edits**: it compared record counts, so an edit, a rename or a new
   progress note left the app reporting 今天已备份.
6. **The record content signature dropped every nested key**, so two records differing only in their
   dates were reported as identical duplicates.
7. **Unknown hashes were never normalised.** The guard tested `!isRouteId(parseHash(hash))`, which
   cannot be true — `parseHash` already falls back to the default route. `#/nonsense` rendered the
   dashboard while the address bar kept a URL naming no view.
8. **Zod was fighting the CSP on every page load.** Its JIT compiler calls `new Function`, which
   `script-src 'self'` refuses; Zod caught the failure and fell back to its interpreted path, so
   validation worked while every load raised a violation nobody was watching. Found by the new
   violation detector, fixed with `z.config({ jitless: true })`.
9. **Every review package understated its own contents by one entry**, and nothing compared the
   stated count with the archive. The verifier now reads the number back out of the shipped summary
   and measures the archive independently — and reports exactly this failure when run against a
   package built by the Phase-1 producer.
10. **A Playwright run could silently test the wrong build.** `reuseExistingServer` attached a package
    build to a `vite preview` server left over from a different working tree. Now `false`.

Two claims of my own were withdrawn after measurement rather than shipped:

- that the two JavaScript inline-style writes were what forced `'unsafe-inline'` in the CSP. A
  mutation test showed `style-src` does not govern CSSOM property writes at all; the directive was
  tightenable because the build emits no inline `<style>` and no `style` attribute. The changes were
  kept on their own merits and the rationale corrected.
- that a missing `.map` file was proven absent by a non-200 response. `vite preview` answers an unknown
  path with the SPA fallback, so the assertion was rewritten to test whether the body **is** a source
  map.

## Manual review

Automated accessibility tooling covers roughly a third of WCAG success criteria. The following were
checked by hand on 2026-09-21, Chromium 1440×900 and an emulated Pixel 7.

| Check                                                                           | Result                                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tab order follows visual order on all six routes                                | Pass                                                                                                  |
| Focus visible on every interactive element, including on coloured buttons       | Pass                                                                                                  |
| Dialogs: focus enters, cycles, Escape closes, focus returns to the trigger      | Pass                                                                                                  |
| Escape from a dirty form raises the discard confirmation rather than discarding | Pass                                                                                                  |
| Destructive confirmations do not focus the confirm button                       | Pass                                                                                                  |
| Collapsible sections operable by keyboard; state conveyed by `aria-expanded`    | Pass                                                                                                  |
| Calendar: arrow/Tab reachable; selection announced via `aria-pressed`           | Pass — each day is a button in a grid; there is no roving-tabindex arrow-key pattern (see open items) |
| Status distinguishable in greyscale                                             | Pass — every badge has a text label                                                                   |
| 200% browser zoom on all routes                                                 | Pass — no horizontal overflow, no clipped controls                                                    |
| `prefers-reduced-motion` honoured                                               | Pass                                                                                                  |
| Windows High Contrast mode                                                      | Pass — borders and focus follow system colours via `forced-colors`                                    |
| Screen-reader spot check (NVDA, work list and record dialog)                    | Pass — headings, labels, statuses and the live region all announce                                    |

## Not tested, and honestly so

- **Safari and iOS on real hardware.** Firefox and WebKit are now covered by an automated
  critical-flow suite (see below), which closes most of the Phase-1 gap — but Playwright's WebKit on
  Windows is **not** Safari. It shares WebCore and differs in OS integration, storage eviction policy,
  the PWA install path and iOS input behaviour. No Apple device was used, and no Safari or iOS result
  is claimed. This remains the largest single gap.
- **Real assistive-technology sweep.** One NVDA spot check is not a full screen-reader pass; JAWS
  and VoiceOver were not exercised.
- **Large datasets.** Behaviour is verified for tens of records, and the architecture is reasoned
  for hundreds-to-low-thousands (`docs/architecture.md`), but no 10,000-record benchmark was run.
- **Storage eviction.** Behaviour under an actual browser eviction event is not reproduced; the
  diagnostics report the state but the eviction path itself is untested.
- **Printed output.** Print CSS is written and reviewed in print preview, but no physical print was
  produced.
- **Concurrent tabs.** Two tabs open on the same database is not tested. Dexie handles the
  connection, but last-write-wins between tabs is unverified.

## Cross-engine verification, and the two defects it found

`npm run test:e2e:cross` runs `cross-browser.spec.ts` on Firefox and WebKit — five critical flows per
engine, chosen because their implementations differ most between engines rather than to maximise a
count. The Chromium desktop project runs the same file, so all three engines are measured on identical
assertions. Browsers install with `npm run test:e2e:install:cross`.

Running it for the first time found two real problems, neither of which any Chromium test could have
surfaced:

1. **`upgrade-insecure-requests` made the application fail to start in WebKit.** Served over plain HTTP
   from `127.0.0.1`, WebKit upgraded every subresource to `https://` and every one failed with
   `SSL connect error`; `#root` stayed empty. Chromium and Firefox exempt loopback as a
   potentially-trustworthy origin, WebKit does not. The directive was removed — it was buying nothing,
   since every URL the app emits is relative and the static scan already fails the build on an absolute
   `http(s)://` reference. See `docs/security.md`.
2. **A mouse click does not focus a button in WebKit**, following the macOS convention. The dialog
   focus-restoration test opened its dialog by clicking, so `document.activeElement` was `<body>` at
   open time and focus correctly returned to `<body>` on close — the test was asserting a platform
   convention rather than our focus handling. It now activates the trigger from the keyboard, which is
   what the test's name always claimed.

Both are recorded here because a new test layer that reports no findings is not being run.

## Open items for Phase 2

1. Safari and iOS on real hardware. Firefox and WebKit are automated; Apple platforms are not.
2. A roving-tabindex arrow-key pattern for the calendar grid — currently each day is an individual
   tab stop, which is operable but verbose on a full month.
3. Reinstate static JSX a11y linting when `eslint-plugin-jsx-a11y` supports ESLint 10.
4. Re-check the ExcelJS→uuid advisory when ExcelJS updates that dependency.
5. Performance characterisation at 5,000+ records, with the denormalised `anchorDay` index if the
   in-memory pass proves insufficient.
6. Multi-tab coherence.
