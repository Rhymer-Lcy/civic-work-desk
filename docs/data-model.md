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

## `meta`: application bookkeeping, and why a backup never restores it

`meta` holds one row describing **this installation**, not the user's data:

| Field                   | Meaning                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `schemaVersion`         | the schema this store was last opened with                      |
| `dataRevision`          | a counter incremented by **every** persisted user-data mutation |
| `lastBackupAt`          | when a JSON backup was last successfully produced               |
| `lastBackupRevision`    | the `dataRevision` that backup captured, or `null` if never     |
| `lastBackupRecordCount` | the record count at that moment, kept for display               |
| `createdAt`             | first-run timestamp                                             |

A restore must not overwrite this. A backup taken on another machine, or three weeks ago, carries
that machine's bookkeeping; adopting it would turn the application's own history into fiction. The
importer therefore never writes `meta` from a backup — it only stamps the post-restore revision (see
below), so a freshly restored database does not immediately report itself as never backed up.

### `dataRevision`, and what "your backup is stale" means

Phase 1 judged backup freshness by comparing the current **record count** with the count recorded at
the last backup. Editing a record, renaming a category, adding a progress note and changing a setting
all leave the count unchanged, so the application kept reporting 今天已备份 while the file on disk no
longer matched the data.

The counter closes that. `withMutation()` in `src/db/client.ts` opens one read-write transaction over
the affected stores **plus `meta`**, runs the mutation, and bumps `dataRevision` inside it. Two
consequences worth stating:

- A backup is stale exactly when `dataRevision > lastBackupRevision`, whatever it was that changed.
- A mutation that throws bumps nothing, because the increment is in the transaction that rolled back.
  `tests/integration/import-integrity.test.ts` asserts that against a failing update.

Every repository mutation goes through that helper, which makes the invariant structural rather than a
rule contributors have to remember.

After a canonical restore the importer sets `lastBackupRevision` to the restored `dataRevision`: the
database now equals a backup the user is holding, so asking for another one would be wrong.

## Migrations

Schema versions are declared in `applyVersions()` in `src/db/schema.ts`. A shipped version block is
never edited; a new one is added. Seeding and version bookkeeping happen once, in
`ensureSeedData()`, inside one transaction. Migration state is a single versioned value in `meta` —
not a scatter of localStorage flags, which in the legacy version could survive a data clear and
leave flags and records out of step.

`meta` is a single value rather than an indexed shape, so adding a field to it needs no Dexie version
bump — but it does need an explicit backfill, which `ensureSeedData()` performs for a row written by
an earlier build. The alternative is `undefined` leaking into arithmetic, which is how a revision
counter silently becomes `NaN`.

### Backup format versions are bounded at both ends

`backupFormatVersion` is checked against a declared supported range rather than `>= 1`:

| Situation                               | Behaviour                                                                |
| --------------------------------------- | ------------------------------------------------------------------------ |
| version 2 (current)                     | accepted                                                                 |
| version 1                               | accepted through an explicit `migrateV1ToV2`, which fills the new fields |
| a version above the current one         | **refused**, naming the version and telling the user to upgrade the app  |
| a `schemaVersion` above the current one | **refused**, naming the version                                          |
| not a number                            | refused                                                                  |

Phase 1 validated `min(1)`, so a file written by a future build was read purely because its shape
happened to validate — the most likely route to destroying data with a "successful" restore.
`src/services/backup/compatibility.ts` is the single place those bounds live, and each failure message
names the cause instead of reporting a generic validation error.

Envelope version 2 adds two fields: `omittedInvalidRowIds`, so a backup can state that it is **not**
complete, and `dataRevision`, so a restored database knows which revision it corresponds to.

### A record's content signature

Import conflict reporting needs "is this incoming row the same as the stored one?", ignoring the audit
timestamps. That comparison is a deep canonical serialisation — the same `canonicalJson` the backup
checksum uses, with `createdAt` and `updatedAt` removed.

It must be a real recursive serialiser. Phase 1 used `JSON.stringify(rest, Object.keys(rest).sort())`,
and a JSON replacer **array filters property names at every depth**, not just the top level. Every
nested key whose name did not coincide with a top-level record key was dropped: `occurredOn.date`,
both ends of a date range, the text of a free-text date, and all of `legacyResidue`. Two records
differing only in their dates produced identical signatures, and merge reported them as harmless
duplicates. `tests/unit/record-signature.test.ts` keeps the defective implementation alongside the
correct one so each assertion states what actually regressed.

## `localStorage`

Used **only** for ephemeral UI preferences, under the `cwd.pref.` prefix, against an allow-list
(`lastRoute`, `workSort`, `ledgerSort`, `reportPeriodType`). No record data ever touches it. That
inversion is the point: the legacy prototype put the whole database there and nothing else.
