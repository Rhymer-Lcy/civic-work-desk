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

### The revision a backup records is the revision it captured

Phase 1.1 wrote `lastBackupRevision = meta.dataRevision` **at the moment the export finished**, which
is not necessarily the revision the file contains:

1. the snapshot captures revision R1 and the envelope is built from it;
2. another tab, or the user typing while a large export serialises, mutates data → R2;
3. the export finishes and reads the meta row, seeing R2;
4. it records `lastBackupRevision = R2`, so `dataRevision === lastBackupRevision`;
5. freshness reports **fresh** although the file on disk contains only R1.

`recordCanonicalBackup({ capturedRevision, recordCount })` takes the revision observed **inside the
snapshot transaction**, so the comparison is against what the file actually holds. If the store has
moved on, the correct state is stale — and `dataRevision` is never rewound to make a file look newer
than it is. `tests/integration/backup-freshness.test.ts` drives exactly that interleaving.

Only a **complete** canonical backup calls that function at all. An acknowledged incomplete export
generates its file, says so, and leaves the backup state untouched; a diagnostic recovery export and
the XLSX/DOCX reports never touch it either.

### Freshness compares business dates, not an instant against a date

`lastBackupAt` is a UTC instant; `today` is a local business date. Phase 1.1 compared
`lastBackupAt.slice(0, 10)` — the **UTC** day — against a local `todayIso()`, and the two disagree for
part of every day: at 16:30 UTC a UTC+8 user is already on the next day. A backup taken seconds earlier
was reported as 「上次备份在 1 天前」 for the whole of a UTC+8 morning.

`businessDateOf()` in `src/domain/dates.ts` converts the instant to a local day, and every comparison
between a stored instant and a business date goes through it. Found on 2026-09-21 at 16:15 UTC, when an
end-to-end assertion of 「今天已备份。」 started failing purely because the clock crossed 16:00.

## Relational invariants, live and at rest

One definition, in `src/domain/integrity.ts`, over plain arrays — no IndexedDB, no envelopes, no React.
The same function answers: may this archive be restored exactly? is the live database valid? may a
backup of it be called complete? would this merge leave a valid state?

| invariant                                                                   | kinds reported          |
| --------------------------------------------------------------------------- | ----------------------- |
| every progress entry points to an existing record                           | `orphan-progress`       |
| every non-null work `categoryId` points to an existing category             | `dangling-category`     |
| every non-null work `groupId` points to an existing group                   | `dangling-group`        |
| every non-null honour `relatedWorkId` points to an existing **work** record | `dangling-related-work` |
| record / progress / category / group ids are unique                         | `duplicate-*-id`        |

Two deliberate non-violations: a **soft-deleted** record still satisfies a reference (the row exists and
is carried in backups, so restoring it restores the relationship), and a **null** reference is always
valid (all three are optional by design).

Phase 1.2 applied these rules only when restoring an archive. The live database was free to reach a
state its own backups could not restore — see the hard-delete policy below — and the application would
produce a file labelled complete and then refuse it.

### Where the rules are enforced

- **Every mutation**: the repositories check that a reference resolves before writing, inside the same
  transaction as the write. A write whose target does not exist fails rather than dangling.
- **Backup viability**: `readBackupSnapshot()` reports `relationalIssues`; a non-empty list makes
  `complete` false and `createBackup()` raise `RelationalIntegrityError`.
- **Restore**: unchanged from Phase 1.2 — an archive that cannot be restored exactly is refused.
- **Merge**: against the projected final state, `destination + acceptedChanges`.

### Hard delete: preserve the honour, detach the link

Permanently deleting a work record removes it and its progress entries, and **sets `relatedWorkId` to
null on every honour that referenced it** — all in one transaction that bumps `dataRevision` once.

The alternatives were considered and rejected. Deleting the honour destroys unrelated user data: an
award records something that happened, whether or not the work item survives. Blocking the purge leaves
the user unable to empty their own Trash without first hunting down every link. Leaving the reference
dangling is what Phase 1.2 did, and it is what made a "complete" backup unrestorable.

The detach is never silent. The Trash confirmation states how many honours will be unlinked before the
user commits, and the toast states how many were.

## The canonical snapshot boundary

`readStoreSnapshot()` in `src/db/snapshot.ts` reads **every user-data store inside one Dexie read-only
transaction**:

```
records · progressEntries · categories · groups · settings · meta
```

Inside that boundary the rows are read raw, validated, partitioned into valid values and invalid rows,
and `meta.dataRevision` is captured.

Phase 1.1 built a backup from six independent repository reads issued through `Promise.all`. Each is
its own IndexedDB transaction, so the archive described records as they were at one instant, categories
at another, and the revision counter at a third — a state that had never simultaneously existed, with
nothing detecting the difference. A concurrent write in another tab was enough to produce it.

Two consequences:

- **the backup is a coherent snapshot**, and the revision it records is the revision it contains;
- **corruption in any store is visible**, because validation happens here rather than inside the
  convenience readers.

The application's own load (`loadSnapshot()` in `src/app/store/data-store.ts`) uses the same function,
so every view and the integrity report beside them describe one read.

### The repositories keep their convenient shapes, on purpose

`listCategories()` and `listGroups()` still return only valid rows, and `getSettings()` still falls back
to the defaults. That is correct **for the UI**: a corrupt category cannot be rendered in a select, and
the application must stay operable.

What was wrong in Phase 1.1 is that a _backup_ was built from those same convenient shapes, so
corruption became silent absence in an archive the product called complete — and `getSettings()`
substituted defaults the user had never chosen. Anything that must account for corruption —
diagnostics, backups, the recovery export — reads the snapshot instead.

A missing settings row is treated as an integrity problem rather than as "no settings", for the same
reason: nothing can tell us what the user's settings were, so a backup must not claim to carry them.

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

| Situation                               | Behaviour                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------- |
| version 3 (current)                     | accepted                                                                    |
| version 2                               | accepted through `migrateV2ToV3`; completeness derived, digest scope kept   |
| version 1                               | accepted through `migrateV1ToV2` then `migrateV2ToV3`; completeness unknown |
| a version above the current one         | **refused**, naming the version and telling the user to upgrade the app     |
| a `schemaVersion` above the current one | **refused**, naming the version                                             |
| not a number                            | refused                                                                     |

Phase 1 validated `min(1)`, so a file written by a future build was read purely because its shape
happened to validate — the most likely route to destroying data with a "successful" restore.
`src/services/backup/compatibility.ts` is the single place those bounds live, and each failure message
names the cause instead of reporting a generic validation error.

### What each envelope version knows about itself

| version | phase     | completeness                                                                          | digest covers                        |
| ------- | --------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| 1       | Phase 1   | nothing — the field did not exist, **and** the build could drop invalid rows silently | `payload`                            |
| 2       | Phase 1.1 | `omittedInvalidRowIds`, but nothing consulted it on import                            | `payload`                            |
| 3       | Phase 1.2 | explicit `completeness`, and the importer enforces it                                 | the whole envelope except the digest |

### Completeness is a property of the file, and it is enforced

`completeness` is one of three values:

- **`complete`** — the producing build verified that every user-data store validated. Only this state
  permits an exact canonical restore.
- **`incomplete`** — the file itself lists rows it could not carry. It may be merged; it may **never**
  be used for an exact restore, because restoring it cannot reproduce the original database. Phase 1.1
  wrote this information into the file and then ignored it on import, so an archive that declared
  itself incomplete was still offered as 完整还原.
- **`unknown-legacy`** — a v1 archive. The format had no completeness field **and** the build that
  wrote it could omit invalid rows without recording anything, so the absence of the field is not
  evidence of completeness. Phase 1.1's migration wrote `omittedInvalidRowIds: []` for such files,
  which reads as "nothing was omitted" — a claim the file cannot support. Restoring one is allowed,
  because refusing every v1 archive would strand anyone whose only backup predates the field, but the
  preview and the destructive confirmation both say that completeness is unknown.

The importer exposes this as `plan.completeness` and `plan.exactRestorePossible`. The UI reads those
rather than re-inspecting the raw file — the decision is made once, in a place tests can reach.

### What the checksum covers, and what it is not

The v3 digest is SHA-256 over **the entire envelope except the checksum field itself**, using the same
`canonicalJson` serialiser as everything else.

Phase 1.1 hashed `payload` alone. `omittedInvalidRowIds` — the field that decides whether a file may
be used for an exact restore — sat outside the digest, so a one-character edit turned an incomplete
archive into a complete-looking one with the checksum still matching.

Every other field participates deliberately: `completeness` and `omittedInvalidRowIds` because they
govern what the file may be used for; `application`, `backupFormatVersion` and `schemaVersion` because
editing them changes how the file is read; `counts` because a mismatch is already a blocker and a
tampered count should not verify; `dataRevision` because it becomes this installation's backup
bookkeeping after a restore; `exportedAt` because it is displayed as provenance. Stating the rule as
"everything except the digest" means a field added later needs no new judgement call.

A v1/v2 file keeps its narrower **payload** scope, recorded in `checksum.scope` and verified that way.
The digest is not recomputed over the wider material on migration: a digest this build calculated
itself would verify nothing about the file as received.

**This is corruption detection, not authentication.** Anyone who edits a file can recompute the
digest. It catches truncation, a stray editor save, a half-written download. There is no key, so
calling it a signature would be false.

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
