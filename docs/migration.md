# Legacy migration

How data from the old 工作记录台 prototype gets into CivicWorkDesk, and what happens to every value
that does not map cleanly.

## The rule

**Never discard, never guess silently.**

Any value that cannot be mapped losslessly is preserved — as a `text` date, as `statusLabel`, or in
`legacyResidue` — and a warning naming the field appears in the import preview. The only row that is
rejected outright is one with no usable title, because a record with no subject cannot be filed or
found again.

## Accepted formats

| Format               | Shape                                                                                                                                                           | Detection                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| CivicWorkDesk backup | `{application: 'civic-work-desk', backupFormatVersion, schemaVersion, exportedAt, counts, completeness, omittedInvalidRowIds, dataRevision, checksum, payload}` | `application` field        |
| Legacy versioned     | `{version: 3, exportTime, works: [...]}`                                                                                                                        | `works` array, no `honors` |
| Legacy split         | `{works: [...], honors: [...]}`                                                                                                                                 | both arrays                |
| Legacy bare array    | `[...]`                                                                                                                                                         | top-level array            |

Anything else is refused with a stated reason. A CivicWorkDesk envelope that fails its schema is
refused rather than partially imported.

## Pipeline

```
parse JSON → detect format → normalise each row → validate (Zod)
   → build plan → PREVIEW → explicit confirmation → one transaction
```

Nothing is written before the confirmation. `buildImportPlan()` is pure over its inputs;
`applyImportPlan()` performs the single transactional write.

The legacy `importJSON()` collapsed all of this into one native `confirm()` whose entire content was
a row count.

## Field mapping

### Work records

| Legacy                       | New                       | Notes                                                    |
| ---------------------------- | ------------------------- | -------------------------------------------------------- |
| `id`                         | `id`                      | preserved, so re-importing the same backup is idempotent |
| `title`                      | `title`                   | required; a blank title rejects the row                  |
| `date`                       | `occurredOn`              | through the date model below                             |
| `requirement` / `require`    | `requirement`             |                                                          |
| `deadline` + `deadlineType`  | `reportDeadline`          | the **value** is parsed on its own merits                |
| `due` + `dueType`            | `completionDeadline`      | same                                                     |
| `doneTime` / `completedTime` | `completedOn`             | frequently free text; preserved                          |
| `done`                       | `status` + `statusLabel`  | canonical status + original wording                      |
| `unit`                       | `counterpartUnit`         |                                                          |
| `contact` / `peer`           | `counterpartContact`      |                                                          |
| `phone`                      | `counterpartPhone`        | **string, never rewritten**                              |
| `remark` / `note`            | `remark`                  |                                                          |
| `longterm`                   | `longTerm`                | orthogonal to status now                                 |
| `biz`                        | `categoryId`              | name → **stable id**                                     |
| `fixedGroup`                 | `groupId`                 | name → **stable id**                                     |
| `progress[]`                 | rows in `progressEntries` | each gets its own stable id                              |
| `createdAt`                  | `createdAt`               | adopted only if a finite, positive number                |
| anything else                | `legacyResidue`           | with a warning                                           |

### Honour records

Detected when `category === '荣誉'`, or when the row has `name` but no `title` (the oldest shape).

| Legacy                   | New                |
| ------------------------ | ------------------ |
| `title` / `name`         | `title`            |
| `date`                   | `awardedOn`        |
| `hType` / `type`         | `honorType`        |
| `hLevel` / `level`       | `level`            |
| `unit` / `from`          | `issuingOrg`       |
| `hNo` / `no`             | `documentNo`       |
| `hRole` / `role`         | `personalRole`     |
| `hEvidence` / `evidence` | `evidenceLocation` |
| `hRelated` / `related`   | `relatedWorkId`    |

## Dates

Every temporal value goes through `parseLegacyDate()`.

| Input                                   | Result                        | Warning                                         |
| --------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `2026-01-04`                            | `plain`                       | none                                            |
| `2026/9/7`, `2026.9.7`, `2026年9月7日`  | `plain`, canonicalised        | info: rewritten                                 |
| `2026-02`, `2026年4月`                  | `range` over that whole month | info when Chinese form                          |
| `1月`, `3月5日`, `4日14日`              | `text`, verbatim              | **warning: year missing**                       |
| `2026-02-30`                            | `text`, verbatim              | **warning: not a real calendar date**           |
| `待定（4月前）`, `长期推进`, `每月例行` | `text`, verbatim              | info when `xType` was `text`, warning otherwise |
| `46100`, any number                     | `text` of the digits          | warning: not a date                             |
| empty / missing                         | `absent`                      | none                                            |

Two things this explicitly does **not** do:

- **It does not infer a year.** `3月5日` in a record sitting between two 2026 rows is _probably_
  2026 — but "probably" is not a basis for writing a date into an archive. The original text is kept
  and the user can set a real date in the form.
- **It does not shift an impossible date.** `2026-02-30` stays as written. `new Date('2026-02-30')`
  would silently produce 2 March.

### The `xType` discriminator is not trusted

The prototype stored a separate `deadlineType`/`dueType` field. The real data shows it is unreliable:
rows exist with `deadlineType: "date"` and free text in `deadline`, and with `dueType: ""` and a
populated `due` (which `normalizeRecord()` would have discarded, since it defaulted a falsy type to
`'none'`). The value is therefore parsed on its own merits and `xType` is used only to decide whether
free text was _intentional_ (info) or _unexpected_ (warning).

## Status

| Legacy `done`              | Canonical                              | Note                                   |
| -------------------------- | -------------------------------------- | -------------------------------------- |
| `完成`, `已完成`           | `completed`                            |                                        |
| `进行中`, `在办`, `办理中` | `in-progress`                          |                                        |
| `未完成`, `待办`, `未开始` | `todo`                                 | **corrects** the legacy classification |
| `取消`, `已取消`, `作废`   | `cancelled`                            |                                        |
| `推迟`, `已推迟`, `延期`   | `deferred`                             |                                        |
| _(empty)_                  | `todo`                                 | the documented legacy default          |
| `完成（已上报）` etc.      | prefix match, flagged `inferred`       | shown in the preview                   |
| unrecognised               | `todo`, original kept in `statusLabel` | **warning**                            |

Two legacy defects corrected here:

- `isOther()` matched `未完成` alongside `取消`/`推迟`, so outstanding work sat in a tab labelled
  "cancelled/postponed" and was excluded from the pending count.
- `statusOf()` tested `longterm` **before** completion, so a finished long-term item displayed as
  长期推进 forever. `longTerm` is now an independent flag and completion always wins.

## Contact values

Observed in the real data: `82393933.0`, `82496017.0`, `82469820.0` (landlines that passed through a
spreadsheet as floats), `656430\n673679` (two numbers in one cell), `X\n136…`, `0579-83118218`.

**None of these is rewritten.** The `.0` suffix is _reported_ — "looks like a spreadsheet-derived
number (trailing `.0`); left unchanged" — because "trailing `.0` is an Excel artefact" is an
inference, and a silent edit to a phone number is the kind of change nobody notices until they dial
it. A value arriving as a JSON _number_ is stored as a string with a warning that leading zeroes may
already have been lost upstream.

## Categories and groups

Legacy records stored the category **name**. Records now reference a **stable id**, so renaming a
category in Settings can never orphan a record (legacy defect D25).

- A `biz` value matching a built-in category name maps to that category's id.
- A `biz` value matching nothing leaves the record uncategorised **and warns** — the name is not
  adopted, because a typo would create a permanent phantom category.
- A row with no `biz` at all falls to the keyword classifier, whose rules are carried over verbatim
  from `BIZ_RULES`. One change: an unmatched title yields `null` (uncategorised) instead of the
  legacy fallback to the _last_ category in the list, which put unrelated work into
  `财务·后勤·综合`.

## Progress entries

Each legacy entry becomes a row in `progressEntries` with its own stable id. Entries with no text are
dropped and the count is reported. Both the object form (`{date, content}`) and the bare-string form
are accepted.

The legacy implementation addressed entries by array index, so deleting entry 0 renumbered every
later entry and a pending edit then wrote to the wrong note.

## Three strategies, resolved from the mode and the file

The user picks a mode — 合并 or 替换 / 还原 — but the mode alone cannot determine what happens,
because a CivicWorkDesk backup and a legacy file support very different promises. The strategy is
resolved from both, and the preview text and the confirm button are named after the result:

| mode      | file                 | strategy            | what it does                                                                                   |
| --------- | -------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| 合并      | any                  | `merge`             | adds only ids absent locally; never overwrites; skipped ids are listed                         |
| 替换/还原 | CivicWorkDesk backup | `canonical-restore` | records, progress, categories, groups **and settings** replaced wholesale — a complete restore |
| 替换/还原 | legacy file          | `legacy-replace`    | records and progress replaced; taxonomy and settings stay local, because the file carries none |

`legacy-replace` is deliberately never presented as 完整还原. A legacy `works` file has no
categories, no groups and no settings; calling it a full restore would tell the user their
configuration had been restored when it had merely been left alone.

A `canonical-restore` is only _permitted_ when the file can actually deliver one — see completeness
and relational integrity below. When it cannot, the operation is refused with a stated reason and the
confirm button reads 无法完整还原. It is never silently downgraded to something narrower after the
user has confirmed, and it is never labelled 完整还原 while being unable to be one.

**Merge never overwrites.** An incoming record whose id already exists is skipped and listed in the
preview, with both titles and both dates shown, and marked when the two are byte-identical (in which
case the skip has no effect). "Byte-identical" is decided by a deep canonical serialisation of the
record minus its audit timestamps; the Phase-1 implementation used a JSON replacer array, which drops
nested keys at every depth, so two records differing only in their dates compared equal.

This is deterministic and non-destructive: the stored row is the one the user has been working with,
and an import is not evidence that the file is newer. To adopt the file's version, use replace mode —
which requires typing a confirmation phrase and destroys the current store inside the same
transaction that writes the new one.

**Progress entries obey the same rule.** Merge writes a progress entry only when its id is absent
locally, and reports every collision with its reason (`duplicate-in-source` or
`exists-in-destination`). Phase 1 wrote progress with an upsert, so an incoming entry silently
replaced a local note carrying the same id, and the preview never mentioned it.

**Every write is one transaction, and it uses `bulkAdd`, never `bulkPut`.** That makes "never
overwrite" a property of the storage call rather than of the plan that precedes it: if a plan ever
disagreed with the destination, the write fails loudly instead of quietly overwriting.

**Duplicate ids inside one file** are rejected outright for a canonical restore — a backup claiming
to be an exact copy of a store cannot contain the same id twice, and proceeding would silently drop a
row. For legacy files the first occurrence wins and the rest are listed: those files are genuinely
messy, and refusing them would block the migration they exist for. The legacy importer built its id
set once before the loop and never added to it, so both rows were inserted, producing duplicate
primary keys.

### What a restore restores, exactly

A canonical restore is measured rather than asserted.
`tests/integration/restore-semantics.test.ts` takes a canonical snapshot of every user-data store,
restores a backup over a diverged database, and requires the snapshot to equal the backup's payload —
same records, same progress, same taxonomy, same settings. It covers the same-backup case, the
diverged case, partial id overlap, transaction rollback on an injected mid-write failure, and the
legacy-replace case where local taxonomy must survive.

All eight of those tests fail against the Phase-1 implementation, in which replace mode deleted the
store and then wrote nothing back — the plan had classified every incoming row as conflicting with
the rows it was itself about to delete.

One store is deliberately **not** restored: `meta`. It holds application bookkeeping — schema
version, revision counter, backup history — which describes this installation, not the user's data.
After a canonical restore the revision counter is stamped as "equal to the backup you hold", so the
application does not immediately ask for a backup of data that just came out of one.

### Merge judges references against the projected final state

A reference is valid when it resolves in the state that will exist **after** the write:

```
finalState = destination + acceptedChanges
```

Phase 1.2 judged an incoming progress entry against _the records accepted from the same file_, so a
perfectly valid note for a record the destination already held was silently skipped — the commonest real
merge there is. And it judged an incoming record's category, group and related-work references against
nothing at all, so a merge could introduce exactly the dangling reference a restore refuses.

The planner therefore places rows in dependency order — taxonomy, then work records, then honours, then
progress — so every decision is made with the projected state already containing everything it could
legitimately depend on. One pass, and the outcome does not depend on the order rows appear in the file.

| incoming row   | accepted when                                                                               |
| -------------- | ------------------------------------------------------------------------------------------- |
| work record    | its id is free **and** its category and group resolve in the projected taxonomy             |
| honour         | its id is free **and** its `relatedWorkId` resolves to a work record in the projected state |
| progress entry | its id is free **and** its `recordId` resolves in the projected state                       |

A row that fails is **refused and reported with its reason** — never written, never rewritten to null,
never resolved by inventing the missing taxonomy. That is also what makes an _incomplete_ archive safe
to merge: a record whose category was omitted from the file, and which the destination does not have
either, is declined rather than silently repaired.

The destination's progress, category and group ids are **required** inputs to `buildImportPlan`. They
were optional in Phase 1.2, and an omitted list silently meant "the destination has none" — turning a
missing argument into skipped rows, or into a raw `ConstraintError` at write time.

### A destructive replace must have something to write

A legacy file whose every row is unimportable contributes no records, so proceeding would clear the
database and write nothing. Import must not become a disguised wipe: `legacy-replace` with zero accepted
records is blocked, and the message points at the dedicated, separately confirmed destructive workflow in
Settings. A canonical restore is deliberately exempt — a verified-complete backup of an empty database is
a real archive, and restoring it is a real operation.

### An exact restore must be _able_ to be exact

A canonical restore promises `restore(D, B(S)) = S`. Several defects break that promise while every
individual row still passes its schema, and Phase 1.1 permitted all of them. Each is now a blocker for
`canonical-restore`, reported in the preview with its reason:

| Refused when                                                 | why an exact restore is impossible                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| the file declares itself `incomplete`                        | it lists rows it could not carry; restoring it cannot reproduce the database     |
| a record id appears twice                                    | one of the two rows would have to be dropped                                     |
| a **progress** id appears twice                              | same, and Phase 1.1 dropped the second row while still calling the restore exact |
| a category or group id appears twice                         | the taxonomy cannot be written as given                                          |
| a progress entry's `recordId` is not in the file             | the note would belong to nothing                                                 |
| a work record's `categoryId` / `groupId` is not in the file  | the restored record would show an association the database cannot resolve        |
| an honour's `relatedWorkId` is not a work record in the file | same, including an honour pointing at another honour                             |

The policy is **refuse, never repair**. Dropping the orphan or nulling the dangling reference would
produce a database that does not match the file the user was told it restored.
`src/services/import/integrity.ts` performs these checks and returns every defect at once, because a
preview that reveals one problem at a time lies about how damaged the file is.

Legacy imports are explicitly out of scope: `legacy-replace` and merge of a legacy file use the
documented best-effort normalisation path, which is allowed to reject rows and report warnings.

## Integrity

A CivicWorkDesk v3 envelope carries a SHA-256 over **the whole envelope except the digest itself** —
including the completeness metadata that decides what the file may be used for. A v1/v2 file's digest
covered only its payload, and the file says so in `checksum.scope`. On import:

| Verdict        | Meaning                          | Effect            |
| -------------- | -------------------------------- | ----------------- |
| `match`        | content is intact                | proceed           |
| `mismatch`     | content was altered after export | **blocked**       |
| `absent`       | file carries no checksum         | reported, allowed |
| `unverifiable` | this runtime cannot hash         | reported, allowed |

The preview also states the scope when it is the narrower `payload`, so a user restoring an older
archive knows the completeness declaration itself was not protected. See `docs/data-model.md` for what
participates in the digest and why, and note that this is corruption detection, not authentication.

Declared counts are also compared against the payload; a mismatch blocks the import.

## Fixtures

`tests/fixtures/legacy-backups.ts` reproduces 20 structural edge cases — every row annotated with
the legacy defect it stands for, and every one asserted in
`tests/unit/legacy-normalisation.test.ts`.

**All synthetic.** Names are placeholders (甲/乙/丙), organisations are generic (示范单位), phone
numbers come from the `138-0013-xxxx` documentation block. No value was copied from the real data.

## Doing a migration

1. In the old application, click 导出备份 to produce a JSON file.
2. In CivicWorkDesk: Settings → 数据与备份 → 导入 / 还原备份.
3. Choose **合并** (into an existing store) or **替换** (a clean restore).
4. Select the file. Read the preview: counts, rejected rows, conflicts, and the migration warnings.
5. Confirm.
6. Work through the warnings: search for records whose date is free text and give them a real date
   where you know it; check any phone number flagged as spreadsheet-derived.
7. Export a fresh CivicWorkDesk JSON backup.

Step 6 is the point of the warnings. They are not noise — each one marks a value the old file could
not represent and this one has preserved rather than invented.
