import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import { META_KEY, SCHEMA_VERSION, SETTINGS_KEY } from '@/db/schema';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { readStoreSnapshot } from '@/db/snapshot';
import { defaultCategories, defaultGroups, defaultSettings } from '@/domain/defaults';
import { validateRelationalIntegrity } from '@/domain/integrity';
import { makeHonor, makeProgress, makeWork } from '../fixtures/records';

/**
 * IndexedDB v1 → v2, from a real v1 database.
 *
 * The v1 side is a Dexie instance that declares **only** the v1 stores — the exact block the Phase-4
 * build shipped — so the rows are written through a v1 connection into a v1 database, closed, and then
 * opened by the application's own class, which runs the v2 upgrade. Nothing here writes a v2 shape and
 * calls it v1.
 *
 * What must hold (docs/phase-5-product-evolution.md §10.1):
 *   - every work row gains `parentWorkId: null` and is otherwise unchanged;
 *   - honours, progress, categories, groups, settings and meta are untouched by the upgrade itself;
 *   - trashed records keep their trash state;
 *   - a row that was invalid stays invalid and is still reported — the migration does not repair.
 */

const V1_STORES = {
  records: 'id, kind, deletedAt, updatedAt, categoryId, groupId, status',
  progressEntries: 'id, recordId, createdAt',
  categories: 'id, sortOrder',
  groups: 'id, sortOrder',
  settings: 'key',
  meta: 'key',
};

let counter = 0;
const opened: Dexie[] = [];

function uniqueName(): string {
  counter += 1;
  return `civic-v1-to-v2-${String(counter)}`;
}

/** Write rows through a connection that knows only schema v1, then close it. */
async function writeV1Database(
  name: string,
  rows: {
    records?: readonly unknown[];
    progressEntries?: readonly unknown[];
    seedReferenceData?: boolean;
  },
): Promise<void> {
  const v1 = new Dexie(name);
  v1.version(1).stores(V1_STORES);
  await v1.open();
  expect(v1.verno).toBe(1);
  if (rows.seedReferenceData !== false) {
    await v1.table('categories').bulkAdd(defaultCategories());
    await v1.table('groups').bulkAdd(defaultGroups());
    await v1.table('settings').put({ key: SETTINGS_KEY, value: defaultSettings() });
    await v1.table('meta').put({
      key: META_KEY,
      value: {
        schemaVersion: 1,
        dataRevision: 7,
        lastBackupAt: null,
        lastBackupRevision: null,
        lastBackupRecordCount: null,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    });
  }
  if (rows.records) await v1.table('records').bulkAdd([...rows.records]);
  if (rows.progressEntries) await v1.table('progressEntries').bulkAdd([...rows.progressEntries]);
  v1.close();
}

/** Open the v1 database with the application's class, which applies every newer version. */
async function openAsApplication(name: string): Promise<CivicWorkDeskDatabase> {
  const db = createDatabase(name);
  opened.push(db);
  await db.open();
  await ensureSeedData(db);
  return db;
}

/** A v1 work row: the Phase-4 shape, with no `parentWorkId` key at all. */
function v1Work(overrides: Parameters<typeof makeWork>[0] = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { ...makeWork(overrides) };
  delete row['parentWorkId'];
  return row;
}

afterEach(async () => {
  setDatabase(null);
  for (const db of opened.splice(0)) await db.delete();
});

describe('IndexedDB v1 → v2', () => {
  it('an ordinary v1 archive: every task becomes top-level, nothing else changes', async () => {
    const name = uniqueName();
    const live = v1Work({ id: 'w-live', title: '一条在办事项' });
    const trashed = v1Work({
      id: 'w-trashed',
      title: '回收站里的事项',
      deletedAt: '2026-09-10T00:00:00.000Z',
    });
    const categorised = v1Work({
      id: 'w-cat',
      categoryId: defaultCategories()[0]?.id ?? null,
      groupId: defaultGroups()[0]?.id ?? null,
    });
    const honor = makeHonor({ id: 'h-1', relatedWorkId: 'w-live' });
    const progress = makeProgress('w-live', '进展一');
    await writeV1Database(name, {
      records: [live, trashed, categorised, honor],
      progressEntries: [progress],
    });

    const db = await openAsApplication(name);
    expect(db.verno).toBe(2);
    expect(SCHEMA_VERSION).toBe(2);

    const rows = await db.records.toArray();
    const byId = new Map(rows.map((row) => [row.id, row as unknown as Record<string, unknown>]));
    for (const original of [live, trashed, categorised]) {
      expect(byId.get(original['id'] as string)).toEqual({ ...original, parentWorkId: null });
    }
    // The honour is byte-for-byte what v1 stored: no hierarchy key appears on it.
    expect(byId.get('h-1')).toEqual(honor);
    expect(Object.hasOwn(byId.get('h-1') ?? {}, 'parentWorkId')).toBe(false);

    expect(await db.progressEntries.toArray()).toEqual([progress]);
    expect(await db.categories.orderBy('sortOrder').toArray()).toEqual(defaultCategories());
    expect(await db.groups.orderBy('sortOrder').toArray()).toEqual(defaultGroups());
    expect((await db.settings.get(SETTINGS_KEY))?.value).toEqual(defaultSettings());

    // Bookkeeping: the schema number moves, the revision counter does not.
    const meta = (await db.meta.get(META_KEY))?.value;
    expect(meta?.schemaVersion).toBe(2);
    expect(meta?.dataRevision).toBe(7);

    // The migrated store is valid, relationally sound, and keeps its trash state.
    setDatabase(db);
    const snapshot = await readStoreSnapshot();
    expect(snapshot.invalid.records).toEqual([]);
    expect(snapshot.records.find((record) => record.id === 'w-trashed')?.deletedAt).toBe(
      '2026-09-10T00:00:00.000Z',
    );
    expect(
      validateRelationalIntegrity({
        records: snapshot.records,
        progressEntries: snapshot.progressEntries,
        categories: snapshot.categories,
        groups: snapshot.groups,
      }),
    ).toEqual([]);
  });

  it('indexes parentWorkId, so children can be found by parent inside a transaction', async () => {
    const name = uniqueName();
    await writeV1Database(name, { records: [v1Work({ id: 'w-1' })] });
    const db = await openAsApplication(name);
    const indexes = db.records.schema.indexes.map((index) => index.name);
    expect(indexes).toContain('parentWorkId');
    // A top-level task has a null key, which IndexedDB leaves out of the index.
    expect(await db.records.where('parentWorkId').equals('w-1').count()).toBe(0);
  });

  it('an empty v1 database opens as v2', async () => {
    const name = uniqueName();
    await writeV1Database(name, { seedReferenceData: false });
    const db = await openAsApplication(name);
    expect(db.verno).toBe(2);
    expect(await db.records.count()).toBe(0);
    expect((await db.meta.get(META_KEY))?.value.schemaVersion).toBe(2);
  });

  it('invalid rows are not repaired: each stays invalid and reported', async () => {
    const name = uniqueName();
    const corruptWork = { id: 'corrupt-work', kind: 'work', title: 7 };
    const corruptHonor = { id: 'corrupt-honor', kind: 'honor', title: '无授予日期' };
    const unknownKind = { id: 'odd-kind', kind: 'memo', title: '未知类型' };
    await writeV1Database(name, {
      records: [v1Work({ id: 'fine' }), corruptWork, corruptHonor, unknownKind],
    });

    const db = await openAsApplication(name);
    const raw = new Map((await db.records.toArray()).map((row) => [row.id, row as unknown]));
    // The work row received the new field — and nothing else about it changed.
    expect(raw.get('corrupt-work')).toEqual({ ...corruptWork, parentWorkId: null });
    // Rows that are not work records were not touched at all.
    expect(raw.get('corrupt-honor')).toEqual(corruptHonor);
    expect(raw.get('odd-kind')).toEqual(unknownKind);

    setDatabase(db);
    const snapshot = await readStoreSnapshot();
    expect(snapshot.records.map((record) => record.id)).toEqual(['fine']);
    expect(snapshot.invalid.records.map((row) => row.id).sort()).toEqual([
      'corrupt-honor',
      'corrupt-work',
      'odd-kind',
    ]);
  });

  it('opening an already-migrated database again changes nothing', async () => {
    const name = uniqueName();
    await writeV1Database(name, { records: [v1Work({ id: 'w-1' })] });
    const first = await openAsApplication(name);
    const before = await first.records.toArray();
    first.close();
    const again = await openAsApplication(name);
    expect(await again.records.toArray()).toEqual(before);
  });
});
