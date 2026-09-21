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

### Unit — 131 tests

| File                           | Covers                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dates.test.ts`                | leap years, century rule, month lengths, impossible dates, **DST boundaries**, month/year rollover, every legacy date shape, range semantics, window overlap, well-formedness                                                                                                 |
| `deadlines.test.ts`            | urgency classification, earlier-of-two-deadlines with attribution, range judged by its end, closed statuses, deferred still in scope, long-term not suppressing a real date, text-only deadlines, 30-day backlog split, follow-up membership                                  |
| `query.test.ts`                | search normalisation incl. full-width space, searchable fields for both kinds, filter composition, soft-delete exclusion, honours never caught by a status filter, date windows, calendar day selection, sorting with undated records last, option derivation, follow-up list |
| `status-and-reports.test.ts`   | every legacy status label, `未完成`→todo, unrecognised→null, period construction, **membership by the record's own date**, first-of-month boundary, completion rate from canonical status, overdue vs stale separation                                                        |
| `legacy-normalisation.test.ts` | all 20 fixtures against the schema; dates, phones, statuses, progress, honours (both shapes), categories, residue, rejection, id preservation                                                                                                                                 |
| `backup-envelope.test.ts`      | canonical JSON key ordering, envelope self-description, JSON round-trip, checksum match/mismatch/absent, counts consistency, filename sortability, backup-health state machine                                                                                                |

### Integration — 36 tests

`database.test.ts` — seeding idempotence, CRUD, schema rejection on write, invalid-row reporting on
read, soft delete and restore, purge with progress, trash emptying, progress entries addressed by
**stable id**, category/group rename integrity, deletion guards, settings persistence, backup meta.

`backup-round-trip.test.ts` — export→wipe→restore byte-identical; trash retained in backups;
tampered backup refused; malformed envelope refused; merge never overwrites; identical conflicts
flagged; duplicate ids inside one file rejected; replace destroys and reports; settings adopted only
on replace; locally renamed categories preserved; all three legacy formats; progress carried over;
re-import idempotent.

### End-to-end — 82 tests across three projects

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
free of `unsafe-eval` and inline scripts; manifest valid with maskable icons and every declared icon
resolving; service worker registers; **offline: create → go offline → reload → records intact → CRUD
still works → no external request**; **no user record content in any Cache API entry**.

**`responsive.spec.ts`** — no horizontal page overflow at 360/390/768/1024/1440 px on all six
routes, with deliberately long Chinese content; ledger becomes a genuine card list (table removed
from the accessibility tree); form single-column with usable control heights; navigation reachable
with `aria-current`; primary action ≥40px on a phone.

**`accessibility.spec.ts`** — axe over nine states; focus trap over 30 tabs; focus restoration;
skip link; keyboard-only record creation; accessible name on every button; 200% zoom.

### Static

`scripts/static-security-scan.mjs` — ten rules over 149 files including `dist/`. Source rules
(inline handlers, `eval`, `new Function`, `dangerouslySetInnerHTML`, `innerHTML`, `document.write`)
apply to our code; egress rules (remote script/link, telemetry hosts, absolute paths, legacy record
ids) apply to the built bundle too. Exceptions are listed in the script with reasons.

## Results

Captured from the run that produced the review package; the raw output is in
`review/VERIFY_LOG.txt`.

| Gate                       | Command                | Result                          |
| -------------------------- | ---------------------- | ------------------------------- |
| Format                     | `npm run format:check` | PASS                            |
| Lint (`--max-warnings=0`)  | `npm run lint`         | PASS                            |
| Typecheck (both projects)  | `npm run typecheck`    | PASS                            |
| Unit + integration         | `npm run test:unit`    | **PASS — 167/167**, 8 files     |
| Production build           | `npm run build`        | PASS                            |
| Static security scan       | `npm run scan:static`  | PASS — 0 findings, 149 files    |
| E2E + responsive + privacy | `npm run test:e2e`     | **PASS — 82/82**                |
| Accessibility (axe)        | `npm run test:a11y`    | PASS — 0 unexplained violations |
| `npm audit --omit=dev`     | high/critical          | PASS — 0 at `high` or above     |

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

- **Firefox and Safari.** All automated testing is Chromium. The application uses no
  Chromium-specific API, and `beforeinstallprompt` absence is handled explicitly, but this is
  untested and is the largest single gap.
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

## Open items for Phase 2

1. Cross-browser verification (Firefox, Safari/iOS).
2. A roving-tabindex arrow-key pattern for the calendar grid — currently each day is an individual
   tab stop, which is operable but verbose on a full month.
3. Reinstate static JSX a11y linting when `eslint-plugin-jsx-a11y` supports ESLint 10.
4. Re-check the ExcelJS→uuid advisory when ExcelJS updates that dependency.
5. Performance characterisation at 5,000+ records, with the denormalised `anchorDay` index if the
   in-memory pass proves insufficient.
6. Multi-tab coherence.
