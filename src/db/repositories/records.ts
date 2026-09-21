import { ABSENT_DATE } from '@/domain/dates';
import type { AnyRecord, HonorRecord, ProgressEntry, WorkRecord } from '@/domain/types';
import { anyRecordSchema, progressEntrySchema } from '@/domain/validation';
import { newId, nowInstant } from '@/utils/clock';
import { withDatabase } from '../client';
import type { CivicWorkDeskDatabase } from '../schema';

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

export interface RecordReadResult {
  readonly records: AnyRecord[];
  /** Ids of rows that failed validation, with a short reason. Surfaced in Settings. */
  readonly invalid: readonly { readonly id: string; readonly reason: string }[];
}

export async function listRecords(): Promise<RecordReadResult> {
  return withDatabase('listRecords', async (db) => {
    const rows = await db.records.toArray();
    const records: AnyRecord[] = [];
    const invalid: { id: string; reason: string }[] = [];
    for (const row of rows) {
      const parsed = anyRecordSchema.safeParse(row);
      if (parsed.success) records.push(parsed.data);
      else {
        const id = typeof row.id === 'string' ? row.id : '(unknown id)';
        invalid.push({ id, reason: parsed.error.issues[0]?.message ?? 'schema mismatch' });
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

export async function createWorkRecord(input: NewWorkRecordInput): Promise<WorkRecord> {
  const record = buildWorkRecord(input);
  await withDatabase('createWorkRecord', (db) => db.records.add(record));
  return record;
}

export async function createHonorRecord(input: NewHonorRecordInput): Promise<HonorRecord> {
  const record = buildHonorRecord(input);
  await withDatabase('createHonorRecord', (db) => db.records.add(record));
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
  return withDatabase('updateRecord', async (db) => {
    return db.transaction('rw', db.records, async () => {
      const existing = await db.records.get(id);
      if (!existing) throw new Error(`record not found: ${id}`);
      const next = { ...existing, ...patch, updatedAt: nowInstant() } as AnyRecord;
      const parsed = anyRecordSchema.safeParse(next);
      if (!parsed.success) {
        throw new Error(
          `refusing to write invalid record: ${parsed.error.issues[0]?.message ?? ''}`,
        );
      }
      await db.records.put(parsed.data);
      return parsed.data;
    });
  });
}

/**
 * Soft delete. The record leaves every default view but stays recoverable from Settings.
 * Progress entries are left attached so a restore is complete.
 */
export async function softDeleteRecord(id: string): Promise<void> {
  await withDatabase('softDeleteRecord', async (db) => {
    const stamp = nowInstant();
    await db.records.update(id, { deletedAt: stamp, updatedAt: stamp });
  });
}

export async function restoreRecord(id: string): Promise<void> {
  await withDatabase('restoreRecord', async (db) => {
    await db.records.update(id, { deletedAt: null, updatedAt: nowInstant() });
  });
}

/** Irreversible. Removes the record and its progress entries in one transaction. */
export async function purgeRecord(id: string): Promise<void> {
  await withDatabase('purgeRecord', (db) =>
    db.transaction('rw', [db.records, db.progressEntries], async () => {
      await db.progressEntries.where('recordId').equals(id).delete();
      await db.records.delete(id);
    }),
  );
}

export async function listDeletedRecords(): Promise<AnyRecord[]> {
  const { records } = await listRecords();
  return records.filter((record) => record.deletedAt !== null);
}

/** Empty the trash. Returns how many records were destroyed. */
export async function purgeAllDeleted(): Promise<number> {
  return withDatabase('purgeAllDeleted', (db) =>
    db.transaction('rw', [db.records, db.progressEntries], async () => {
      const rows = await db.records.toArray();
      const doomed = rows.filter((row) => row.deletedAt !== null).map((row) => row.id);
      for (const id of doomed) {
        await db.progressEntries.where('recordId').equals(id).delete();
      }
      await db.records.bulkDelete(doomed);
      return doomed.length;
    }),
  );
}

/* ------------------------------------------------------------------ progress */

export async function listProgressEntries(recordId?: string): Promise<ProgressEntry[]> {
  return withDatabase('listProgressEntries', async (db) => {
    const rows =
      recordId === undefined
        ? await db.progressEntries.toArray()
        : await db.progressEntries.where('recordId').equals(recordId).toArray();
    return rows
      .map((row) => progressEntrySchema.safeParse(row))
      .filter((r) => r.success)
      .map((r) => r.data as ProgressEntry)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  await withDatabase('addProgressEntry', (db) => db.progressEntries.add(entry));
  return entry;
}

export async function updateProgressEntry(
  id: string,
  patch: Partial<Pick<ProgressEntry, 'note' | 'occurredOn'>>,
): Promise<void> {
  await withDatabase('updateProgressEntry', async (db) => {
    await db.progressEntries.update(id, { ...patch, updatedAt: nowInstant() });
  });
}

export async function deleteProgressEntry(id: string): Promise<void> {
  await withDatabase('deleteProgressEntry', (db) => db.progressEntries.delete(id));
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
  await withDatabase('replaceAllRecords', (db: CivicWorkDeskDatabase) =>
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
