# Architecture

CivicWorkDesk is a client-only React application. There is no server, no API and no build-time
secret. Everything below runs in the user's browser.

## Layering

```
┌──────────────────────────────────────────────────────────────────┐
│ src/features/*        views: dashboard, work, honors, ledger,    │
│ src/components/*      reports, settings, backup-restore          │
│                       — rendering + local UI state only          │
└───────────────┬──────────────────────────────────────────────────┘
                │ reads one snapshot, calls actions
┌───────────────▼──────────────────────────────────────────────────┐
│ src/app/store/data-context.tsx                                   │
│   one snapshot of every table + refresh()                        │
└───────────────┬──────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────┐   ┌──────────────────────────────┐
│ src/db/repositories/*        │   │ src/services/*               │
│   the only code that touches │   │   backup, import, export,    │
│   Dexie; validates on read   │   │   download, storage          │
│   and before write           │   │                              │
└───────────────┬──────────────┘   └──────────┬───────────────────┘
                │                             │
┌───────────────▼─────────────────────────────▼───────────────────┐
│ src/domain/*   pure, synchronous, no I/O, no React              │
│   dates · status · deadlines · query · reports · validation     │
└─────────────────────────────────────────────────────────────────┘
```

The rule that matters: **a view never decides what "overdue", "completed" or "in this month" means.**
Those live in `src/domain` and have exactly one implementation each. The legacy prototype had five
different overdue tests and two filter implementations that disagreed (see `legacy-audit.md` D15,
D16), which is the specific failure this layering prevents.

## Modules

### `src/domain` — pure logic

| Module          | Responsibility                                                |
| --------------- | ------------------------------------------------------------- |
| `dates.ts`      | the `DateValue` tagged union; all date-only, local arithmetic |
| `status.ts`     | `WorkStatus` enum; legacy label → canonical mapping           |
| `types.ts`      | entities; `work` / `honor` discriminated union                |
| `deadlines.ts`  | `evaluateDeadline` — the single urgency verdict               |
| `query.ts`      | `runQuery` — the single filter/search/sort implementation     |
| `reports.ts`    | period construction, membership, `summarise`                  |
| `validation.ts` | Zod schemas guarding both untrusted boundaries                |
| `defaults.ts`   | seed categories, groups, options; legacy keyword classifier   |

Nothing here imports React, Dexie or any browser API. Every function is directly testable, and
131 of the 167 automated tests exercise this layer alone.

### `src/db` — persistence

`schema.ts` declares the Dexie database; `migrations/` holds versioned schema work and first-run
seeding; `repositories/` is the only code that touches tables.

Repositories validate in both directions: a row read from IndexedDB is parsed against its schema and
reported if it fails (never silently repaired), and a write is rejected if the resulting record
would be invalid.

### `src/services` — side effects

`backup/` (envelope, checksum, health), `import/` (legacy normalisation, plan, apply),
`export/` (XLSX, DOCX), `storage/` (Storage API, UI preferences), `download.ts`.

### `src/app` — composition

`router.ts` (60-line hash router), `store/data-context.tsx` (the snapshot),
`pwa/` (service-worker bridge, install prompt).

### `src/features` — one directory per destination

Each owns its page, its dialogs and its CSS module.

## Data flow

**Read:** `DataProvider` loads every table once on mount into a single `DataSnapshot` (records,
progress, categories, groups, settings, meta, backup health, invalid rows, today). Views read from
it via `useData()`.

**Write:** a view calls a repository (usually through `useRecordActions`), the repository commits
one IndexedDB transaction, then `refresh()` reloads the snapshot.

This is deliberately simple. Re-reading a few hundred rows after a write is imperceptible, and it
removes a whole class of cache-coherence bugs: no view can hold a stale record, and no two panels
can compute their counts from different snapshots.

**Scaling note.** The in-memory pass is appropriate for a personal work log (hundreds to low
thousands of rows). If the working set grows an order of magnitude, the fix is a denormalised
`anchorDay` index column maintained by the repositories — _not_ a second filter implementation.

## Date handling

The one piece of domain logic worth stating here. `DateValue` is:

```ts
{
  kind: 'absent';
}
{
  kind: 'plain';
  date: 'YYYY-MM-DD';
}
{
  kind: 'range';
  start: 'YYYY-MM-DD';
  end: 'YYYY-MM-DD';
}
{
  kind: 'text';
  text: string;
}
```

Nothing is ever coerced. A value we cannot prove is a calendar date is preserved verbatim as `text`
and the user is told. All arithmetic is date-only and local — `toLocalDate()` is the single bridge
from string to `Date`, and it never uses UTC parsing. Full rationale in `data-model.md`.

## Bundle strategy

Manual chunks in `vite.config.ts` split vendor code by purpose. The two report writers are
**dynamically imported** at the call site:

```ts
const { buildWorkbook } = await import('@/services/export/xlsx');
const docx = await import('docx');
```

Their types are imported with `import type`, which `verbatimModuleSyntax` erases, so the code stays
fully typed while the bundle is unaffected.

Measured on the committed build (gzip):

| Chunk                   | Loaded    | gzip           |
| ----------------------- | --------- | -------------- |
| `vendor-react`          | initial   | 65.9 KB        |
| `index` (app)           | initial   | 45.0 KB        |
| `vendor-db` (Dexie)     | initial   | 31.3 KB        |
| `vendor-schema` (Zod)   | initial   | 25.8 KB        |
| `vendor-icons`          | initial   | 7.2 KB         |
| `workbox-window`        | initial   | 2.3 KB         |
| runtime + `vendor-date` | initial   | 1.1 KB         |
| **initial total**       |           | **≈ 178.6 KB** |
| `vendor-xlsx` (ExcelJS) | on demand | 256.5 KB       |
| `vendor-docx`           | on demand | 102.6 KB       |

Budget: 250 KiB gzip for initial JavaScript. Current headroom ≈ 71 KB.

## PWA

A static `public/manifest.webmanifest` and real PNG icons (generated by
`scripts/generate-icons.mjs`), plus a Workbox service worker generated by `vite-plugin-pwa` in
`generateSW` mode with `registerType: 'prompt'`.

**Precache is the application shell only** — JS, CSS, HTML, icons, manifest. There is no
`runtimeCaching` entry at all, so no response containing user data can enter the Cache API. This is
asserted by an E2E test that writes an identifiable record and then searches every cache entry for
it.

The export vendor chunks _are_ precached, deliberately: generating a report is a core workflow and
must keep working offline. That is why the precache is ~1.9 MB.

Updates never apply themselves. `onNeedRefresh` shows a banner; the user chooses when to reload, so
an update cannot discard a half-filled form.

## What is deliberately absent

No state-management library (one context is enough), no UI framework, no CSS framework, no router
dependency, no date-picker component (the native control is better), no virtual list, no i18n
runtime (the product is single-locale). Each of these would add weight without answering a problem
this application has.
