import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  deleteProgressEntry,
  getRecord,
  listDeletedRecords,
  listProgressEntries,
  listRecords,
  progressCounts,
  purgeAllDeleted,
  purgeRecord,
  restoreRecord,
  softDeleteRecord,
  updateProgressEntry,
  updateRecord,
} from '@/db/repositories/records';
import {
  addCategory,
  addGroup,
  categoryUsage,
  deleteCategoryIfUnused,
  deleteGroup,
  getMeta,
  getSettings,
  listCategories,
  listGroups,
  moveCategory,
  recordCanonicalBackup,
  renameCategory,
  renameGroup,
  saveSettings,
} from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { BUILT_IN_CATEGORY_IDS } from '@/domain/defaults';
import { isWorkRecord } from '@/domain/types';

/**
 * Integration tests against a real IndexedDB (fake-indexeddb), exercising the actual Dexie code
 * paths: transactions, schema versions, unique keys and rollback.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-work-desk-test-${String(counter)}`);
  await db.open();
  await ensureSeedData(db);
  setDatabase(db);
});

afterEach(async () => {
  setDatabase(null);
  await db.delete();
});

function workInput(overrides: Record<string, unknown> = {}) {
  return {
    title: '示范工作事项',
    occurredOn: { kind: 'plain', date: '2026-09-01' } as const,
    status: 'todo' as const,
    statusLabel: '',
    requirement: '',
    reportDeadline: ABSENT_DATE,
    completionDeadline: ABSENT_DATE,
    completedOn: ABSENT_DATE,
    categoryId: null,
    groupId: null,
    longTerm: false,
    counterpartUnit: '',
    counterpartContact: '',
    counterpartPhone: '',
    remark: '',
    ...overrides,
  };
}

describe('seeding and migration bookkeeping', () => {
  it('seeds built-in categories, groups, settings and meta exactly once', async () => {
    expect(await listCategories()).toHaveLength(12);
    expect(await listGroups()).toHaveLength(3);
    const meta = await getMeta();
    expect(meta?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(meta?.lastBackupAt).toBeNull();

    // Idempotent: a second run must not duplicate anything.
    const second = await ensureSeedData(db);
    expect(second.seeded).toBe(false);
    expect(await listCategories()).toHaveLength(12);
    expect(await listGroups()).toHaveLength(3);
  });

  it('orders categories by sortOrder, not insertion order', async () => {
    const categories = await listCategories();
    const orders = categories.map((c) => c.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(categories[0]?.id).toBe(BUILT_IN_CATEGORY_IDS.africaCooperation);
  });
});

describe('record CRUD', () => {
  it('creates, reads, updates and stamps updatedAt', async () => {
    const created = await createWorkRecord(workInput({ title: '第一条' }));
    expect(created.id).toMatch(/^test-id-/);
    expect(created.deletedAt).toBeNull();

    const fetched = await getRecord(created.id);
    expect(fetched?.title).toBe('第一条');

    const updated = await updateRecord(created.id, { title: '改过的标题', status: 'completed' });
    expect(updated.title).toBe('改过的标题');
    expect(isWorkRecord(updated) && updated.status).toBe('completed');
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('refuses to write a record that fails its schema', async () => {
    const created = await createWorkRecord(workInput());
    await expect(
      updateRecord(created.id, {
        // An impossible calendar date must never reach the store.
        occurredOn: { kind: 'plain', date: '2026-02-30' },
      }),
    ).rejects.toThrow(/invalid record/);
    const unchanged = await getRecord(created.id);
    expect(unchanged && isWorkRecord(unchanged) && unchanged.occurredOn).toEqual({
      kind: 'plain',
      date: '2026-09-01',
    });
  });

  it('reports rows that fail validation instead of silently dropping them', async () => {
    await createWorkRecord(workInput());
    // Write a malformed row directly, as an older build or devtools might.
    await db.records.put({ id: 'broken', kind: 'work' } as never);
    const result = await listRecords();
    expect(result.records).toHaveLength(1);
    expect(result.invalid.map((row) => row.id)).toEqual(['broken']);
  });

  it('creates honour records with honour fields', async () => {
    const honor = await createHonorRecord({
      title: '示范荣誉',
      awardedOn: { kind: 'plain', date: '2026-06-20' },
      honorType: '表彰（先进集体/个人）',
      level: '市级',
      issuingOrg: '示范单位',
      documentNo: '示范发〔2026〕1号',
      personalRole: '集体荣誉',
      evidenceLocation: '展示柜',
      relatedWorkId: null,
      remark: '',
    });
    expect(honor.kind).toBe('honor');
    const fetched = await getRecord(honor.id);
    expect(fetched?.kind).toBe('honor');
  });
});

describe('soft delete and trash', () => {
  it('hides a soft-deleted record from live queries but keeps it recoverable', async () => {
    const record = await createWorkRecord(workInput({ title: '要删除的' }));
    await softDeleteRecord(record.id);

    const { records } = await listRecords();
    expect(records.find((r) => r.id === record.id)?.deletedAt).not.toBeNull();
    expect((await listDeletedRecords()).map((r) => r.id)).toEqual([record.id]);

    await restoreRecord(record.id);
    expect(await listDeletedRecords()).toEqual([]);
    expect((await getRecord(record.id))?.deletedAt).toBeNull();
  });

  it('purges a record together with its progress entries, in one transaction', async () => {
    const record = await createWorkRecord(workInput());
    await addProgressEntry({ recordId: record.id, note: '进展一' });
    await addProgressEntry({ recordId: record.id, note: '进展二' });
    expect(await listProgressEntries(record.id)).toHaveLength(2);

    await purgeRecord(record.id);
    expect(await getRecord(record.id)).toBeNull();
    expect(await listProgressEntries(record.id)).toHaveLength(0);
  });

  it('empties the trash and reports how many records were destroyed', async () => {
    const a = await createWorkRecord(workInput({ title: 'a' }));
    const b = await createWorkRecord(workInput({ title: 'b' }));
    await createWorkRecord(workInput({ title: 'kept' }));
    await softDeleteRecord(a.id);
    await softDeleteRecord(b.id);
    await addProgressEntry({ recordId: a.id, note: '会被一并删除' });

    const purged = await purgeAllDeleted();

    expect(purged.recordsPurged).toBe(2);

    // Nothing referenced the purged records, so nothing needed detaching.
    expect(purged.honorsDetached).toBe(0);
    const { records } = await listRecords();
    expect(records.map((r) => r.title)).toEqual(['kept']);
    expect(await listProgressEntries(a.id)).toHaveLength(0);
  });
});

describe('progress entries', () => {
  it('addresses entries by stable id, so deleting one does not disturb the others', async () => {
    // The legacy implementation addressed entries by array index, so deleting entry 0 renumbered
    // every later entry and a pending edit then wrote to the wrong note.
    const record = await createWorkRecord(workInput());
    const first = await addProgressEntry({ recordId: record.id, note: '第一条' });
    const second = await addProgressEntry({ recordId: record.id, note: '第二条' });
    const third = await addProgressEntry({ recordId: record.id, note: '第三条' });

    await deleteProgressEntry(first.id);
    await updateProgressEntry(third.id, { note: '第三条（已修改）' });

    const remaining = await listProgressEntries(record.id);
    expect(remaining.map((e) => e.id)).toEqual([second.id, third.id]);
    expect(remaining.find((e) => e.id === second.id)?.note).toBe('第二条');
    expect(remaining.find((e) => e.id === third.id)?.note).toBe('第三条（已修改）');
  });

  it('counts entries per record', async () => {
    const a = await createWorkRecord(workInput({ title: 'a' }));
    const b = await createWorkRecord(workInput({ title: 'b' }));
    await addProgressEntry({ recordId: a.id, note: '1' });
    await addProgressEntry({ recordId: a.id, note: '2' });
    await addProgressEntry({ recordId: b.id, note: '3' });

    const counts = await progressCounts();
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBe(1);
  });
});

describe('category and group integrity', () => {
  it('keeps records attached across a category rename', async () => {
    // The legacy version stored the category NAME on each record, so a rename orphaned them.
    const category = await addCategory('自定义分类');
    const record = await createWorkRecord(workInput({ categoryId: category.id }));

    await renameCategory(category.id, '改名后的分类');

    const fetched = await getRecord(record.id);
    expect(fetched && isWorkRecord(fetched) && fetched.categoryId).toBe(category.id);
    expect((await listCategories()).find((c) => c.id === category.id)?.name).toBe('改名后的分类');
    expect((await categoryUsage()).get(category.id)).toBe(1);
  });

  it('rejects a duplicate or empty category name', async () => {
    await addCategory('唯一分类');
    await expect(addCategory('唯一分类')).rejects.toThrow(/already exists/);
    await expect(renameCategory(BUILT_IN_CATEGORY_IDS.feedback, '  ')).rejects.toThrow(/empty/);
  });

  it('refuses to delete a category that is still in use', async () => {
    const category = await addCategory('使用中的分类');
    await createWorkRecord(workInput({ categoryId: category.id }));
    expect(await deleteCategoryIfUnused(category.id)).toBe(false);
    expect((await listCategories()).some((c) => c.id === category.id)).toBe(true);
  });

  it('deletes an unused custom category but never a built-in one', async () => {
    const category = await addCategory('未使用的分类');
    expect(await deleteCategoryIfUnused(category.id)).toBe(true);
    expect(await deleteCategoryIfUnused(BUILT_IN_CATEGORY_IDS.feedback)).toBe(false);
  });

  it('swaps sort order when a category is moved', async () => {
    const before = await listCategories();
    const first = before[0];
    const second = before[1];
    expect(first && second).toBeTruthy();
    if (!first || !second) return;

    await moveCategory(first.id, 1);
    const after = await listCategories();
    expect(after[0]?.id).toBe(second.id);
    expect(after[1]?.id).toBe(first.id);
  });

  it('detaches members when a group is deleted and reports the count', async () => {
    const group = await addGroup('自定义分组');
    const a = await createWorkRecord(workInput({ groupId: group.id }));
    await createWorkRecord(workInput({ groupId: group.id }));

    const detached = await deleteGroup(group.id);
    expect(detached).toBe(2);
    const fetched = await getRecord(a.id);
    expect(fetched && isWorkRecord(fetched) && fetched.groupId).toBeNull();
    expect((await listGroups()).some((g) => g.id === group.id)).toBe(false);
  });

  it('keeps records attached across a group rename', async () => {
    const group = await addGroup('原分组名');
    const record = await createWorkRecord(workInput({ groupId: group.id }));
    await renameGroup(group.id, '新分组名');
    const fetched = await getRecord(record.id);
    expect(fetched && isWorkRecord(fetched) && fetched.groupId).toBe(group.id);
  });
});

describe('settings and backup metadata', () => {
  it('persists settings and rejects invalid ones', async () => {
    const settings = await getSettings();
    const saved = await saveSettings({ ...settings, appTitle: '自定义标题' });
    expect(saved.appTitle).toBe('自定义标题');
    expect((await getSettings()).appTitle).toBe('自定义标题');

    await expect(saveSettings({ ...settings, appTitle: '' })).rejects.toThrow();
    await expect(saveSettings({ ...settings, backupReminderDays: 0 })).rejects.toThrow();
  });

  it('records a successful backup with its captured revision and record count', async () => {
    const before = await getMeta();
    // The revision the snapshot captured is passed in; it is never read from the meta row here,
    // which is what makes the completion race impossible.
    await recordCanonicalBackup({ capturedRevision: 7, recordCount: 42 });
    const meta = await getMeta();
    expect(meta?.lastBackupAt).toBe('2026-09-21T09:00:00.000Z');
    expect(meta?.lastBackupRecordCount).toBe(42);
    expect(meta?.lastBackupRevision).toBe(7);
    expect(meta?.dataRevision, 'recording a backup is not a data mutation').toBe(
      before?.dataRevision,
    );
  });
});
