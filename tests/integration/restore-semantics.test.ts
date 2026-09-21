import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  softDeleteRecord,
  updateRecord,
} from '@/db/repositories/records';
import {
  addCategory,
  addGroup,
  getSettings,
  listCategories,
  listGroups,
  renameCategory,
  saveSettings,
} from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { canonicalJson } from '@/services/backup/envelope';
import { buildEnvelope } from '@/services/backup/envelope';
import { snapshotForBackup } from '@/services/backup';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan } from '@/services/import/plan';

/**
 * Restore semantics — the Phase-1.1 P0 regression suite.
 *
 * Phase 1 (commit 3727a186) lost data here. `buildImportPlan()` compared incoming record ids
 * against the destination in **every** mode, classified any id that already existed as a
 * conflict, and dropped it from `accepted`. `applyImportPlan()` then cleared the store in replace
 * mode and wrote only `accepted`. Restoring a backup of the current database therefore cleared it
 * and restored nothing — the single most damaging thing a backup feature can do.
 *
 * Every test below is written so it FAILS against that implementation.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-restore-test-${String(counter)}`);
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

/**
 * Everything a canonical backup is contracted to carry, in a comparable form.
 * Deliberately NOT a re-read of the backup file: it reads the live database.
 */
async function restoreableSnapshot(): Promise<string> {
  const [{ records }, progress, categories, groups, settings] = await Promise.all([
    listRecords(),
    listProgressEntries(),
    listCategories(),
    listGroups(),
    getSettings(),
  ]);
  return canonicalJson({
    records: [...records].sort((a, b) => a.id.localeCompare(b.id)),
    progress: [...progress].sort((a, b) => a.id.localeCompare(b.id)),
    categories: [...categories].sort((a, b) => a.id.localeCompare(b.id)),
    groups: [...groups].sort((a, b) => a.id.localeCompare(b.id)),
    settings,
  });
}

/** The same shape, read out of a backup envelope rather than the database. */
function envelopeSnapshot(envelope: Awaited<ReturnType<typeof buildEnvelope>>): string {
  const p = envelope.payload;
  return canonicalJson({
    records: [...p.records].sort((a, b) => a.id.localeCompare(b.id)),
    progress: [...p.progressEntries].sort((a, b) => a.id.localeCompare(b.id)),
    categories: [...p.categories].sort((a, b) => a.id.localeCompare(b.id)),
    groups: [...p.groups].sort((a, b) => a.id.localeCompare(b.id)),
    settings: p.settings,
  });
}

async function exportBackup() {
  return buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
}

async function exactRestore(envelope: unknown): Promise<void> {
  const { records } = await listRecords();
  const plan = await buildImportPlan({ parsed: envelope, mode: 'replace', existing: records });
  await applyImportPlan(plan);
}

describe('canonical exact restore', () => {
  it('REGRESSION: restores a backup whose record ids all still exist in the destination', async () => {
    // This is the exact user story that destroyed data in Phase 1:
    // A and B exist -> export -> A and B still exist -> restore that backup.
    const a = await createWorkRecord(workInput({ title: '记录甲' }));
    const b = await createWorkRecord(workInput({ title: '记录乙' }));
    await addProgressEntry({ recordId: a.id, note: '甲的进展' });
    await addProgressEntry({ recordId: b.id, note: '乙的进展' });
    await addCategory('自定义分类');
    await addGroup('自定义分组');
    await saveSettings({ ...(await getSettings()), appTitle: '备份时的标题' });

    const envelope = await exportBackup();
    const before = await restoreableSnapshot();
    expect(envelopeSnapshot(envelope)).toBe(before);

    await exactRestore(envelope);

    const after = await restoreableSnapshot();
    // Phase 1 produced an EMPTY store here.
    expect(after).toBe(envelopeSnapshot(envelope));

    const { records } = await listRecords();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await listProgressEntries()).toHaveLength(2);
  });

  it('REGRESSION: restores exactly the backup after the destination has diverged', async () => {
    const a = await createWorkRecord(workInput({ title: '备份中的甲' }));
    const b = await createWorkRecord(workInput({ title: '备份中的乙' }));
    await addProgressEntry({ recordId: a.id, note: '备份中的进展' });
    const custom = await addCategory('备份时的分类');
    await saveSettings({ ...(await getSettings()), appTitle: '备份时的标题' });

    const envelope = await exportBackup();
    const expected = envelopeSnapshot(envelope);

    // Diverge: edit A, trash B, add C, rename the category, change settings.
    await updateRecord(a.id, { title: '本机改过的甲' });
    await softDeleteRecord(b.id);
    const c = await createWorkRecord(workInput({ title: '备份之后新增的丙' }));
    await addProgressEntry({ recordId: c.id, note: '备份之后的进展' });
    await renameCategory(custom.id, '本机改过的分类');
    await saveSettings({ ...(await getSettings()), appTitle: '本机改过的标题' });
    expect(await restoreableSnapshot()).not.toBe(expected);

    await exactRestore(envelope);

    expect(await restoreableSnapshot()).toBe(expected);

    const { records } = await listRecords();
    // Post-backup record is gone; the edit is reverted; the trashed record is back.
    expect(records.some((r) => r.id === c.id)).toBe(false);
    expect(records.find((r) => r.id === a.id)?.title).toBe('备份中的甲');
    expect(records.find((r) => r.id === b.id)?.deletedAt).toBeNull();
    expect((await listCategories()).find((x) => x.id === custom.id)?.name).toBe('备份时的分类');
    expect((await getSettings()).appTitle).toBe('备份时的标题');
    expect((await listProgressEntries()).map((e) => e.note)).toEqual(['备份中的进展']);
  });

  it('REGRESSION: produces exactly the backup when destination ids only partially overlap', async () => {
    const shared = await createWorkRecord(workInput({ title: '两边都有的记录' }));
    const onlyInBackup = await createWorkRecord(workInput({ title: '只在备份里的记录' }));
    await addProgressEntry({ recordId: shared.id, note: '共享记录的进展' });

    const envelope = await exportBackup();
    const expected = envelopeSnapshot(envelope);

    // Destination keeps `shared`, loses `onlyInBackup`, gains a local-only record.
    await db.records.delete(onlyInBackup.id);
    const localOnly = await createWorkRecord(workInput({ title: '只在本机的记录' }));

    await exactRestore(envelope);

    expect(await restoreableSnapshot()).toBe(expected);
    const ids = (await listRecords()).records.map((r) => r.id).sort();
    expect(ids).toEqual([shared.id, onlyInBackup.id].sort());
    expect(ids).not.toContain(localOnly.id);
  });

  it('REGRESSION: restores categories, groups and settings exactly, not add-if-missing', async () => {
    const renamed = await addCategory('原始分类名');
    const group = await addGroup('原始分组名');
    await saveSettings({
      ...(await getSettings()),
      appTitle: '备份标题',
      backupReminderDays: 14,
    });
    const envelope = await exportBackup();

    // Locally rename both and change settings. Phase 1 kept all three, because taxonomy was
    // merged add-if-missing and the ids already existed.
    await renameCategory(renamed.id, '本机改过的分类名');
    await saveSettings({ ...(await getSettings()), appTitle: '本机标题', backupReminderDays: 3 });
    const extraCategory = await addCategory('备份之后新增的分类');

    await exactRestore(envelope);

    const categories = await listCategories();
    expect(categories.find((c) => c.id === renamed.id)?.name).toBe('原始分类名');
    expect(categories.some((c) => c.id === extraCategory.id)).toBe(false);
    expect((await listGroups()).find((g) => g.id === group.id)?.name).toBe('原始分组名');
    const settings = await getSettings();
    expect(settings.appTitle).toBe('备份标题');
    expect(settings.backupReminderDays).toBe(14);
  });

  it('REGRESSION: a failed exact restore rolls back and leaves the database untouched', async () => {
    const a = await createWorkRecord(workInput({ title: '回滚测试甲' }));
    await addProgressEntry({ recordId: a.id, note: '回滚测试进展' });
    await addCategory('回滚测试分类');
    const envelope = await exportBackup();
    const before = await restoreableSnapshot();

    // Provoke a failure partway through the restore transaction: the categories table rejects
    // the second write. `Dexie.Table.bulkAdd` is the call the restore uses for taxonomy.
    const originalBulkAdd = db.categories.bulkAdd.bind(db.categories);
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.categories as any).bulkAdd = () => {
      calls += 1;
      throw new Error('injected failure inside the restore transaction');
    };

    const { records } = await listRecords();
    const plan = await buildImportPlan({ parsed: envelope, mode: 'replace', existing: records });
    await expect(applyImportPlan(plan)).rejects.toThrow();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.categories as any).bulkAdd = originalBulkAdd;
    expect(calls).toBeGreaterThan(0);

    // The clear must NOT have survived the failed transaction.
    expect(await restoreableSnapshot()).toBe(before);
    expect((await listRecords()).records).toHaveLength(1);
    expect(await listProgressEntries()).toHaveLength(1);
  });
});

describe('legacy replace', () => {
  it('replaces records and progress but retains local taxonomy and settings', async () => {
    const local = await createWorkRecord(workInput({ title: '本机原有记录' }));
    await addProgressEntry({ recordId: local.id, note: '本机原有进展' });
    const category = await addCategory('本机分类');
    await saveSettings({ ...(await getSettings()), appTitle: '本机标题' });

    const legacy = { works: [{ id: 'legacy_1', title: '旧版记录', date: '2026-01-01' }] };
    const { records } = await listRecords();
    const plan = await buildImportPlan({ parsed: legacy, mode: 'replace', existing: records });
    // The preview must not claim a whole-application restore for a format that cannot provide one.
    expect(plan.strategy).toBe('legacy-replace');
    expect(plan.restoresTaxonomy).toBe(false);
    await applyImportPlan(plan);

    const after = await listRecords();
    expect(after.records.map((r) => r.id)).toEqual(['legacy_1']);
    expect(await listProgressEntries()).toHaveLength(0);
    // Retained, because the legacy file carries none of it.
    expect((await listCategories()).some((c) => c.id === category.id)).toBe(true);
    expect((await getSettings()).appTitle).toBe('本机标题');
  });

  it('a canonical envelope in replace mode is a canonical restore, not a legacy replace', async () => {
    await createWorkRecord(workInput({ title: '示范' }));
    const envelope = await exportBackup();
    const { records } = await listRecords();
    const plan = await buildImportPlan({ parsed: envelope, mode: 'replace', existing: records });
    expect(plan.strategy).toBe('canonical-restore');
    expect(plan.restoresTaxonomy).toBe(true);
  });
});

describe('merge is unchanged and still never overwrites', () => {
  it('skips a destination id clash and reports it', async () => {
    const a = await createWorkRecord(workInput({ title: '本机版本' }));
    const envelope = await exportBackup();
    await updateRecord(a.id, { title: '本机后来改过的标题' });

    const { records } = await listRecords();
    const plan = await buildImportPlan({ parsed: envelope, mode: 'merge', existing: records });
    expect(plan.strategy).toBe('merge');
    expect(plan.accepted).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    await applyImportPlan(plan);

    expect((await listRecords()).records.find((r) => r.id === a.id)?.title).toBe(
      '本机后来改过的标题',
    );
  });
});
