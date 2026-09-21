# Data model

Database: IndexedDB, name `civic-work-desk`, accessed through Dexie. Schema version **1**.

## Stores

| Store             | Primary key | Indexes                                                             | Contents                              |
| ----------------- | ----------- | ------------------------------------------------------------------- | ------------------------------------- |
| `records`         | `id`        | `kind`, `deletedAt`, `updatedAt`, `categoryId`, `groupId`, `status` | work + honour records                 |
| `progressEntries` | `id`        | `recordId`, `createdAt`                                             | progress notes                        |
| `categories`      | `id`        | `sortOrder`                                                         | business categories                   |
| `groups`          | `id`        | `sortOrder`                                                         | fixed / long-term / supervised groups |
| `settings`        | `key`       | —                                                                   | one row, key `app`                    |
| `meta`            | `key`       | —                                                                   | one row, key `app`                    |

**Indexing is deliberately narrow.** Only identity, lifecycle and referential fields are indexed;
filtering happens in the domain query engine over an in-memory snapshot. Two reasons:

1. `DateValue` is a tagged union, so a dotted index path such as `occurredOn.date` is _absent_ on
   `text` and `absent` values. Dexie omits those rows from the index, which would make an indexed
   date query silently miss exactly the records the date model exists to preserve.
2. A single filter implementation is a hard requirement — the legacy prototype's two divergent
   filter paths were a real defect (`legacy-audit.md` D16).

## `DateValue`

```ts
type DateValue =
  | { kind: 'absent' }
  | { kind: 'plain'; date: IsoDate } // 'YYYY-MM-DD', a real calendar day
  | { kind: 'range'; start: IsoDate; end: IsoDate } // start <= end
  | { kind: 'text'; text: string }; // non-empty, preserved verbatim
```

### Why a union rather than a string

The legacy prototype stored every temporal field as a bare string and pushed it through
`new Date(...)`. Three failures followed, all present in the real data:

- `new Date('1月')` is `Invalid Date`; `createdAt` became `NaN` and the record vanished from every
  report.
- `new Date('2026-01-04')` parses as **UTC** midnight, while the report window was built from
  local-midnight `new Date(y, m-1, 1)`. In any negative-UTC-offset timezone a record dated the 1st
  of a month fell into the previous month.
- Free text like `待定（4月前）` and `3月5日12时前` carries real operational meaning and had nowhere to
  live once coerced.

### Invariants

- `plain.date` is a **real** calendar day. `2026-02-30` is rejected at the schema boundary and never
  shifted to March 2nd.
- `range.start <= range.end`, always. The editor normalises reversed input.
- `text.text` is never empty — an empty input yields `absent`.
- All arithmetic is date-only and local. `toLocalDate()` is the only bridge from string to `Date`
  and never uses UTC parsing. `daysBetween` uses `differenceInCalendarDays`, so a DST boundary
  (a 23- or 25-hour local day) still counts as one day.

### Semantics

| Function         | Meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `effectiveDay`   | the day to **judge** against — the **end** of a range (a March window is not late on the 2nd) |
| `anchorDay`      | the earliest day touched — used for sorting and year/month bucketing                          |
| `overlapsWindow` | membership in a half-open `[start, endExclusive)` window                                      |

## `WorkStatus`

```ts
type WorkStatus = 'todo' | 'in-progress' | 'completed' | 'cancelled' | 'deferred';
```

| Property                 | Members                           |
| ------------------------ | --------------------------------- |
| terminal (never overdue) | `completed`, `cancelled`          |
| open                     | `todo`, `in-progress`, `deferred` |
| bears urgency            | `todo`, `in-progress`, `deferred` |

`deferred` is **open**: postponing work does not close it and does not remove its deadline.

`statusLabel` preserves the wording a migrated record arrived with, so an archive still reads the
way its author wrote it. It is display-only — every calculation uses `status`.

### Legacy label mapping

| Legacy `done`              | Canonical                  | Note                                                            |
| -------------------------- | -------------------------- | --------------------------------------------------------------- |
| `完成`, `已完成`           | `completed`                |                                                                 |
| `进行中`, `在办`, `办理中` | `in-progress`              |                                                                 |
| `未完成`, `待办`, `未开始` | `todo`                     | legacy `isOther()` filed 未完成 with cancelled/postponed        |
| `取消`, `已取消`, `作废`   | `cancelled`                |                                                                 |
| `推迟`, `已推迟`, `延期`   | `deferred`                 |                                                                 |
| _(empty)_                  | `todo`                     | documented legacy default, not an inference                     |
| prefix match               | as above, `inferred: true` | reported in the import preview                                  |
| anything else              | **`null`**                 | import files it as `todo`, keeps the original, raises a warning |

## Entities

### `WorkRecord`

| Field                                   | Type                            | Legacy source                       |
| --------------------------------------- | ------------------------------- | ----------------------------------- |
| `id`                                    | `string` (UUID for new records) | `id`                                |
| `kind`                                  | `'work'`                        | derived from `category`             |
| `title`                                 | `string`                        | `title`                             |
| `occurredOn`                            | `DateValue`                     | `date`                              |
| `status`                                | `WorkStatus`                    | `done`                              |
| `statusLabel`                           | `string`                        | `done`, verbatim                    |
| `requirement`                           | `string`                        | `requirement`                       |
| `reportDeadline`                        | `DateValue`                     | `deadline` + `deadlineType`         |
| `completionDeadline`                    | `DateValue`                     | `due` + `dueType`                   |
| `completedOn`                           | `DateValue`                     | `doneTime`                          |
| `categoryId`                            | `string \| null`                | `biz` (name → **stable id**)        |
| `groupId`                               | `string \| null`                | `fixedGroup` (name → **stable id**) |
| `longTerm`                              | `boolean`                       | `longterm`                          |
| `counterpartUnit`                       | `string`                        | `unit`                              |
| `counterpartContact`                    | `string`                        | `contact`                           |
| `counterpartPhone`                      | **`string`**                    | `phone`                             |
| `remark`                                | `string`                        | `remark`                            |
| `legacyResidue`                         | `Record<string,string> \| null` | unrecognised fields                 |
| `createdAt` / `updatedAt` / `deletedAt` | ISO instant / nullable          | —                                   |

### `HonorRecord`

`title`, `awardedOn`, `honorType`, `level`, `issuingOrg`, `documentNo`, `personalRole`,
`evidenceLocation`, `relatedWorkId`, `remark`, plus the audit fields.

Honours are a **separate shape**, not a work record with a flag. In the legacy model every honour
field sat unused on all 178 work rows and every deadline field sat unused on the honour rows.

### `ProgressEntry`

`id`, `recordId`, `occurredOn`, `note`, `createdAt`, `updatedAt` — its own store with its own
stable id. The legacy version kept progress in an array on the record and addressed entries by
array index, so deleting entry 0 renumbered every later entry and a pending edit hit the wrong row.

### `BusinessCategory` / `WorkGroup`

`id`, `name`, `sortOrder`, `builtIn`, `archived`.

**Records reference `id`.** This is the fix for `legacy-audit.md` D25: the legacy model stored the
category _name_ on each record, so renaming a category silently detached every record that used it.

## Invariants enforced at the boundary

`src/domain/validation.ts` holds Zod schemas applied at both untrusted boundaries — a user-supplied
backup file, and every read from IndexedDB.

1. Every `DateValue` is well-formed (`isWellFormedDateValue`).
2. `status` is one of the five canonical values.
3. `id`, `createdAt`, `updatedAt` are non-empty; `updatedAt` is refreshed on every write.
4. `counterpartPhone` is a `string`, always.
5. `categoryId` / `groupId` are either `null` or a non-empty id.
6. A record failing validation on **read** is excluded from all views and **reported** in Settings →
   数据诊断 — never silently repaired, never silently dropped.
7. A write that would produce an invalid record is **rejected**; the stored row is unchanged.

## Soft delete

`deletedAt !== null` means the record is in the trash. It is excluded from every default query,
every count and every report, but:

- it is **retained in JSON backups**, so a restore is complete;
- its progress entries stay attached, so a restore is whole.

**Retention: indefinite until emptied by hand.** No automatic expiry — a work archive has no natural
retention window, and a silent background purge would be the worst kind of data loss. Emptying the
trash requires a typed confirmation.

## Derived state

Nothing derived is stored. Urgency, counts, completion rate, follow-up membership and category
distributions are computed on read from `src/domain`. The legacy prototype recomputed the category
guesser on every page load and persisted it only if a later action happened to call `saveData()`,
so whether a record had a category depended on what the user did next.

## Migrations

Schema versions are declared in `applyVersions()` in `src/db/schema.ts`. A shipped version block is
never edited; a new one is added. Seeding and version bookkeeping happen once, in
`ensureSeedData()`, inside one transaction. Migration state is a single versioned value in `meta` —
not a scatter of localStorage flags, which in the legacy version could survive a data clear and
leave flags and records out of step.

## `localStorage`

Used **only** for ephemeral UI preferences, under the `cwd.pref.` prefix, against an allow-list
(`lastRoute`, `workSort`, `ledgerSort`, `reportPeriodType`). No record data ever touches it. That
inversion is the point: the legacy prototype put the whole database there and nothing else.
