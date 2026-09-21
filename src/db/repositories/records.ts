import { ABSENT_DATE } from '@/domain/dates';
import type { AnyRecord, HonorRecord, ProgressEntry, WorkRecord } from '@/domain/types';
import { anyRecordSchema, progressEntrySchema } from '@/domain/validation';
import { newId, nowInstant } from '@/utils/clock';
import { withDatabase, withMutation } from '../client';
import type { CivicWorkDeskDatabase } from '../schema';
import type { InvalidRow } from '../invalid-row';

/**
 * Record and progress-entry persistence.
 *
 * Every mutation is committed in its own IndexedDB transaction before the call resolves. There
 * is no write buffer, no `beforeunload` flush and no debounce — the legacy prototype's
 * `saveData()` rewrote the whole array on each change, which meant a failure lost everything,
 * not just the change in flight.
 *
 * Reads validate. A row that fails its schema is reported, not silently repaired, so a corrupt
 * store produces a visible error instead of a plausible-looking but wrong list.
 */

/*
 * `InvalidRow` lives in `../invalid-row` because every user-data store needs it, not only records.
 * Re-exported here so existing call sites keep working.
 */
export type { InvalidRow } from '../invalid-row';

export interface RecordReadResult {
  readonly records: AnyRecord[];
  /** Rows that failed validation. Surfaced in Settings; never silently dropped. */
  readonly invalid: readonly InvalidRow[];
}

export async function listRecords(): Promise<RecordReadResult> {
  return withDatabase('listRecords', async (db) => {
    const rows = await db.records.toArray();
    const records: AnyRecord[] = [];
    const invalid: InvalidRow[] = [];
    for (const row of rows) {
      const parsed = anyRecordSchema.safeParse(row);
      if (parsed.success) records.push(parsed.data);
      else {
        const id = typeof row.id === 'string' ? row.id : '(unknown id)';
        invalid.push({
          id,
          reason: parsed.error.issues[0]?.message ?? 'schema mismatch',
          raw: row,
        });
      }
    }
    return { records, invalid };
  });
}

export async function getRecord(id: string): Promise<AnyRecord | null> {
  return withDatabase('getRecord', async (db) => {
    const row = await db.records.get(id);
    if (!row) return null;
    const parsed = anyRecordSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  });
}

/** Fields a caller supplies when creating a work record; the rest are derived. */
export type NewWorkRecordInput = Omit<
  WorkRecord,
  'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'legacyResidue'
>;

export type NewHonorRecordInput = Omit<
  HonorRecord,
  'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'legacyResidue'
>;

export function buildWorkRecord(input: NewWorkRecordInput): WorkRecord {
  const stamp = nowInstant();
  return {
    ...input,
    id: newId(),
    kind: 'work',
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    legacyResidue: null,
  };
}

export function buildHonorRecord(input: NewHonorRecordInput): HonorRecord {
  const stamp = nowInstant();
  return {
    ...input,
    id: newId(),
    kind: 'honor',
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    legacyResidue: null,
  };
}

/**
 * Refuse a write whose references do not resolve, inside the caller's transaction.
 *
 * The live database must satisfy the same relational rules a canonical restore demands
 * (`@/domain/integrity`). Checking here — rather than trusting the UI to only offer existing ids — is
 * what makes the guarantee structural: a reference can only be written when its target exists, so no
 * mutation path can leave a state the application's own backup would refuse.
 *
 * A soft-deleted target is accepted deliberately: the row exists and is carried in backups.
 */
async function assertReferencesResolve(
  db: CivicWorkDeskDatabase,
  record: AnyRecord,
): Promise<void> {
  if (record.kind === 'work') {
    if (record.categoryId !== null && !(await db.categories.get(record.categoryId))) {
      throw new Error(`business category does not exist: ${record.categoryId}`);
    }
    if (record.groupId !== null && !(await db.groups.get(record.groupId))) {
      throw new Error(`work group does not exist: ${record.groupId}`);
    }
    return;
  }
  if (record.relatedWorkId === null) return;
  const target = await db.records.get(record.relatedWorkId);
  if (!target) throw new Error(`related work record does not exist: ${record.relatedWorkId}`);
  if (target.kind !== 'work') {
    throw new Error(`related record is not a work record: ${record.relatedWorkId}`);
  }
}

export async function createWorkRecord(input: NewWorkRecordInput): Promise<WorkRecord> {
  const record = buildWorkRecord(input);
  await withMutation('createWorkRecord', ['records', 'categories', 'groups'], async (db) => {
    await assertReferencesResolve(db, record);
    await db.records.add(record);
  });
  return record;
}

export async function createHonorRecord(input: NewHonorRecordInput): Promise<HonorRecord> {
  const record = buildHonorRecord(input);
  await withMutation('createHonorRecord', ['records'], async (db) => {
    await assertReferencesResolve(db, record);
    await db.records.add(record);
  });
  return record;
}

/** Patch a work record. `updatedAt` is always refreshed; identity fields cannot be patched. */
export type WorkRecordPatch = Partial<
  Omit<WorkRecord, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deletedAt'>
>;

export type HonorRecordPatch = Partial<
  Omit<HonorRecord, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deletedAt'>
>;

export async function updateRecord(
  id: string,
  patch: WorkRecordPatch | HonorRecordPatch,
): Promise<AnyRecord> {
  return withMutation('updateRecord', ['records', 'categories', 'groups'], async (db) => {
    {
      const existing = await db.records.get(id);
      if (!existing) throw new Error(`record not found: ${id}`);
      const next = { ...existing, ...patch, updatedAt: nowInstant() } as AnyRecord;
      const parsed = anyRecordSchema.safeParse(next);
      if (!parsed.success) {
        throw new Error(
          `refusing to write invalid record: ${parsed.error.issues[0]?.message ?? ''}`,
        );
      }
      // An edit can dangle a reference as easily as a creation can — re-pointing an honour at a work
      // record that has since been purged, for instance.
      await assertReferencesResolve(db, parsed.data);
      await db.records.put(parsed.data);
      return parsed.data;
    }
  });
}

/**
 * Soft delete. The record leaves every default view but stays recoverable from Settings.
 * Progress entries are left attached so a restore is complete.
 */
export async function softDeleteRecord(id: string): Promise<void> {
  await withMutation('softDeleteRecord', ['records'], async (db) => {
    const stamp = nowInstant();
    await db.records.update(id, { deletedAt: stamp, updatedAt: stamp });
  });
}

export async function restoreRecord(id: string): Promise<void> {
  await withMutation('restoreRecord', ['records'], async (db) => {
    await db.records.update(id, { deletedAt: null, updatedAt: nowInstant() });
  });
}

/** What a permanent deletion actually did, so the UI can report the relational consequence. */
export interface PurgeOutcome {
  readonly recordsPurged: number;
  readonly progressPurged: number;
  /** Honour records whose `relatedWorkId` was set to null because their work record was removed. */
  readonly honorsDetached: number;
}

/**
 * Detach every honour that references one of `workIds`, inside the caller's transaction.
 *
 * Read-modify-put rather than a partial `update`: Dexie's `UpdateSpec` cannot express a patch over a
 * discriminated union, and writing the whole row keeps it valid by construction.
 */
async function detachHonorReferences(
  db: CivicWorkDeskDatabase,
  workIds: ReadonlySet<string>,
): Promise<number> {
  if (workIds.size === 0) return 0;
  const rows = await db.records.toArray();
  const stamp = nowInstant();
  let detached = 0;
  for (const row of rows) {
    if (row.kind !== 'honor') continue;
    if (row.relatedWorkId === null || !workIds.has(row.relatedWorkId)) continue;
    const updated: HonorRecord = { ...row, relatedWorkId: null, updatedAt: stamp };
    await db.records.put(updated);
    detached += 1;
  }
  return detached;
}

/**
 * Irreversible. Removes the record, its progress entries, and any honour link to it.
 *
 * **The honour is preserved and its reference detached**, in the same transaction. Phase 1.2 deleted
 * the work record and its progress and left every honour pointing at a row that no longer existed —
 * an ordinary Trash operation that produced a live state the application's own canonical backup could
 * not restore. Deleting the honour instead would destroy unrelated user data (an award is a record of
 * something that happened, whether or not the work item survives), and blocking the purge would leave
 * the user unable to empty their own Trash without first hunting down every link.
 *
 * The detach is reported rather than silent: the Trash confirmation says how many honours will be
 * unlinked, and the toast says how many were.
 */
export async function purgeRecord(id: string): Promise<PurgeOutcome> {
  return withMutation('purgeRecord', ['records', 'progressEntries'], async (db) => {
    const progressPurged = await db.progressEntries.where('recordId').equals(id).count();
    await db.progressEntries.where('recordId').equals(id).delete();
    const target = await db.records.get(id);
    // Only a work record can be referenced by an honour, so nothing to detach otherwise.
    const honorsDetached =
      target?.kind === 'work' ? await detachHonorReferences(db, new Set([id])) : 0;
    await db.records.delete(id);
    return { recordsPurged: target ? 1 : 0, progressPurged, honorsDetached };
  });
}

/**
 * How many honours would be unlinked by permanently deleting `workIds`.
 *
 * Used by the Trash confirmation so the dialog can state the consequence before the user commits.
 * It is a read, deliberately separate from the mutation — the authoritative detach happens inside
 * `purgeRecord` / `purgeAllDeleted`, which report what they actually did.
 */
export async function countLinkedHonors(workIds: readonly string[]): Promise<number> {
  if (workIds.length === 0) return 0;
  const targets = new Set(workIds);
  return withDatabase('countLinkedHonors', async (db) => {
    const rows = await db.records.toArray();
    return rows.filter(
      (row) => row.kind === 'honor' && row.relatedWorkId !== null && targets.has(row.relatedWorkId),
    ).length;
  });
}

export async function listDeletedRecords(): Promise<AnyRecord[]> {
  const { records } = await listRecords();
  return records.filter((record) => record.deletedAt !== null);
}

/**
 * Empty the trash, atomically.
 *
 * Every affected honour is detached first, then the doomed rows and their progress are removed, all
 * inside one transaction that bumps the revision exactly once. An honour that is *itself* in the trash
 * is purged along with the rest, so it needs no detaching — the reference dies with the referrer.
 */
export async function purgeAllDeleted(): Promise<PurgeOutcome> {
  return withMutation('purgeAllDeleted', ['records', 'progressEntries'], async (db) => {
    const rows = await db.records.toArray();
    const doomed = rows.filter((row) => row.deletedAt !== null).map((row) => row.id);
    const doomedWork = new Set(
      rows.filter((row) => row.deletedAt !== null && row.kind === 'work').map((row) => row.id),
    );

    let progressPurged = 0;
    for (const id of doomed) {
      progressPurged += await db.progressEntries.where('recordId').equals(id).count();
      await db.progressEntries.where('recordId').equals(id).delete();
    }

    // Detach before deleting: `detachHonorReferences` walks the records table, and an honour that is
    // also doomed must not be rewritten on its way out.
    const survivingHonorRefs = new Set(doomedWork);
    const honorsDetached = await detachHonorReferencesExcept(
      db,
      survivingHonorRefs,
      new Set(doomed),
    );

    await db.records.bulkDelete(doomed);
    return { recordsPurged: doomed.length, progressPurged, honorsDetached };
  });
}

/** Like `detachHonorReferences`, but skips honours that are themselves about to be deleted. */
async function detachHonorReferencesExcept(
  db: CivicWorkDeskDatabase,
  workIds: ReadonlySet<string>,
  skipIds: ReadonlySet<string>,
): Promise<number> {
  if (workIds.size === 0) return 0;
  const rows = await db.records.toArray();
  const stamp = nowInstant();
  let detached = 0;
  for (const row of rows) {
    if (row.kind !== 'honor' || skipIds.has(row.id)) continue;
    if (row.relatedWorkId === null || !workIds.has(row.relatedWorkId)) continue;
    const updated: HonorRecord = { ...row, relatedWorkId: null, updatedAt: stamp };
    await db.records.put(updated);
    detached += 1;
  }
  return detached;
}

/* ------------------------------------------------------------------ progress */

export async function listProgressEntries(recordId?: string): Promise<ProgressEntry[]> {
  return (await readProgressEntries(recordId)).entries;
}

export interface ProgressReadResult {
  readonly entries: ProgressEntry[];
  readonly invalid: readonly InvalidRow[];
}

/**
 * Like `listProgressEntries`, but also reports rows that failed validation.
 *
 * Progress entries can be corrupted exactly as records can, and a backup that silently omitted
 * them would be just as misleading.
 */
export async function readProgressEntries(recordId?: string): Promise<ProgressReadResult> {
  return withDatabase('readProgressEntries', async (db) => {
    const rows =
      recordId === undefined
        ? await db.progressEntries.toArray()
        : await db.progressEntries.where('recordId').equals(recordId).toArray();
    const entries: ProgressEntry[] = [];
    const invalid: InvalidRow[] = [];
    for (const row of rows) {
      const parsed = progressEntrySchema.safeParse(row);
      if (parsed.success) entries.push(parsed.data);
      else {
        const id = typeof row.id === 'string' ? row.id : '(unknown id)';
        invalid.push({
          id,
          reason: parsed.error.issues[0]?.message ?? 'schema mismatch',
          raw: row,
        });
      }
    }
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { entries, invalid };
  });
}

export interface NewProgressInput {
  readonly recordId: string;
  readonly note: string;
  readonly occurredOn?: ProgressEntry['occurredOn'];
}

export async function addProgressEntry(input: NewProgressInput): Promise<ProgressEntry> {
  const stamp = nowInstant();
  const entry: ProgressEntry = {
    id: newId(),
    recordId: input.recordId,
    occurredOn: input.occurredOn ?? ABSENT_DATE,
    note: input.note,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await withMutation('addProgressEntry', ['progressEntries', 'records'], async (db) => {
    // A note for a record that does not exist is an orphan, which a canonical restore refuses.
    if (!(await db.records.get(entry.recordId))) {
      throw new Error(`record does not exist: ${entry.recordId}`);
    }
    await db.progressEntries.add(entry);
  });
  return entry;
}

export async function updateProgressEntry(
  id: string,
  patch: Partial<Pick<ProgressEntry, 'note' | 'occurredOn'>>,
): Promise<void> {
  await withMutation('updateProgressEntry', ['progressEntries'], async (db) => {
    await db.progressEntries.update(id, { ...patch, updatedAt: nowInstant() });
  });
}

export async function deleteProgressEntry(id: string): Promise<void> {
  await withMutation('deleteProgressEntry', ['progressEntries'], (db) =>
    db.progressEntries.delete(id),
  );
}

/** Counts per record id, so a list can show "3 条进展" without loading every note. */
export async function progressCounts(): Promise<ReadonlyMap<string, number>> {
  const entries = await listProgressEntries();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.recordId, (counts.get(entry.recordId) ?? 0) + 1);
  }
  return counts;
}

/** Used by replace-mode restore. Destroys all records and progress in one transaction. */
export async function replaceAllRecords(
  records: readonly AnyRecord[],
  progress: readonly ProgressEntry[],
): Promise<void> {
  await withDatabase('replaceAllRecords', (db) =>
    db.transaction('rw', [db.records, db.progressEntries], async () => {
      await db.records.clear();
      await db.progressEntries.clear();
      if (records.length > 0) await db.records.bulkAdd(records);
      if (progress.length > 0) await db.progressEntries.bulkAdd(progress);
    }),
  );
}

/** Used by merge-mode restore. Adds only the ids supplied; never overwrites an existing row. */
export async function bulkAddRecords(
  records: readonly AnyRecord[],
  progress: readonly ProgressEntry[],
): Promise<void> {
  await withDatabase('bulkAddRecords', (db) =>
    db.transaction('rw', [db.records, db.progressEntries], async () => {
      if (records.length > 0) await db.records.bulkAdd(records);
      if (progress.length > 0) await db.progressEntries.bulkAdd(progress);
    }),
  );
}
