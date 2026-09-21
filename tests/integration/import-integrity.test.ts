import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  updateRecord,
} from '@/db/repositories/records';
import {
  getMeta,
  getSettings,
  listCategories,
  listGroups,
  recordCanonicalBackup,
  saveSettings,
} from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { assessBackupHealth } from '@/services/backup';
import { buildEnvelope } from '@/services/backup/envelope';
import { snapshotForBackup } from '@/services/backup';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan } from '@/services/import/plan';

/*
 * The destination taxonomy, read at call time.
 *
 * `buildImportPlan` requires it: an incoming record's category and group are judged against the
 * projected final taxonomy, so a caller that omitted them would be claiming the destination has none
 * and every record carrying a category would be rejected as unresolvable.
 */
async function destinationTaxonomy(): Promise<{
  categories: string[];
  groups: string[];
  progressIds: string[];
}> {
  const [categories, groups, progress] = await Promise.all([
    listCategories(),
    listGroups(),
    listProgressEntries(),
  ]);
  return {
    categories: categories.map((category) => category.id),
    groups: groups.map((group) => group.id),
    progressIds: progress.map((entry) => entry.id),
  };
}

/**
 * Import integrity — progress-entry collisions, and the data-revision invariant.
 *
 * Phase 1 wrote progress with `bulkPut`, an upsert, so an incoming progress id that collided with
 * a destination id silently replaced the destination's note. Nothing in the preview mentioned it.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-integrity-test-${String(counter)}`);
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

async function planFor(parsed: unknown, mode: 'merge' | 'replace') {
  const { records } = await listRecords();
  const progress = await listProgressEntries();
  return buildImportPlan({
    parsed,
    mode,
    existing: records,
    existingCategoryIds: (await destinationTaxonomy()).categories,
    existingGroupIds: (await destinationTaxonomy()).groups,
    existingProgressIds: progress.map((entry) => entry.id),
  });
}

describe('progress-entry collision integrity', () => {
  it('REGRESSION: merge never overwrites a destination progress entry', async () => {
    const record = await createWorkRecord(workInput({ title: '本机记录' }));
    const localEntry = await addProgressEntry({ recordId: record.id, note: '本机原有进展' });

    // A file carrying a *different* record but reusing the destination's progress id.
    const envelope = await buildEnvelope(
      {
        records: [{ ...record, id: 'incoming-record', title: '外来记录' }],
        progressEntries: [
          { ...localEntry, id: localEntry.id, recordId: 'incoming-record', note: '外来进展' },
        ],
        categories: [],
        groups: [],
        settings: await getSettings(),
      },
      '2026-09-21T09:00:00.000Z',
    );

    const plan = await planFor(envelope, 'merge');
    // Preview must surface it deterministically...
    expect(plan.progressCollisions).toHaveLength(1);
    expect(plan.progressCollisions[0]?.reason).toBe('exists-in-destination');
    expect(plan.summary.progressCollisions).toBe(1);
    // ...and the write must match the preview.
    expect(plan.acceptedProgress).toHaveLength(0);

    await applyImportPlan(plan);

    const entries = await listProgressEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.note).toBe('本机原有进展');
    expect(entries[0]?.recordId).toBe(record.id);
  });

  it('REGRESSION: detects a duplicate progress id inside one backup file', async () => {
    const record = await createWorkRecord(workInput());
    const entry = await addProgressEntry({ recordId: record.id, note: '第一条' });
    const envelope = await buildEnvelope(
      {
        records: [{ ...record, id: 'r-new' }],
        progressEntries: [
          { ...entry, id: 'dup-progress', recordId: 'r-new', note: '第一条' },
          { ...entry, id: 'dup-progress', recordId: 'r-new', note: '第二条（重复 ID）' },
        ],
        categories: [],
        groups: [],
        settings: await getSettings(),
      },
      '2026-09-21T09:00:00.000Z',
    );

    const plan = await planFor(envelope, 'merge');
    expect(plan.progressCollisions).toHaveLength(1);
    expect(plan.progressCollisions[0]?.reason).toBe('duplicate-in-source');
    expect(plan.acceptedProgress).toHaveLength(1);

    // The write must not throw: the plan already removed the duplicate.
    await applyImportPlan(plan);
    const written = (await listProgressEntries()).filter((e) => e.id === 'dup-progress');
    expect(written).toHaveLength(1);
    expect(written[0]?.note).toBe('第一条');
  });

  it('rejects adversarial input rather than writing a malformed progress entry', async () => {
    const hostile = {
      works: [
        {
          id: 'x1',
          title: '恶意输入',
          date: '2026-01-01',
          progress: [
            { date: '2026-01-02', content: '正常一条' },
            null,
            42,
            { content: '' },
            { date: '不是日期', content: '日期无效但内容有效' },
          ],
        },
      ],
    };
    const plan = await planFor(hostile, 'merge');
    // Two usable notes survive; the null, the number and the empty one are dropped and counted.
    expect(plan.acceptedProgress).toHaveLength(2);
    await applyImportPlan(plan);
    const entries = await listProgressEntries();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.note.trim() !== '')).toBe(true);
    expect(entries.every((e) => typeof e.id === 'string' && e.id.length > 0)).toBe(true);
  });

  it('a canonical restore carries every progress entry, collisions being irrelevant', async () => {
    const record = await createWorkRecord(workInput());
    await addProgressEntry({ recordId: record.id, note: '进展一' });
    await addProgressEntry({ recordId: record.id, note: '进展二' });
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');

    const plan = await planFor(envelope, 'replace');
    expect(plan.strategy).toBe('canonical-restore');
    expect(plan.progressCollisions).toHaveLength(0);
    expect(plan.acceptedProgress).toHaveLength(2);

    await applyImportPlan(plan);
    expect(await listProgressEntries()).toHaveLength(2);
  });
});

describe('data revision drives backup health', () => {
  it('REGRESSION: an edit that leaves the record count unchanged makes the backup stale', async () => {
    const record = await createWorkRecord(workInput({ title: '原标题' }));
    await recordCanonicalBackup({
      capturedRevision: (await getMeta())?.dataRevision ?? null,
      recordCount: 1,
    });

    const fresh = await getMeta();
    expect(fresh?.lastBackupRevision).toBe(fresh?.dataRevision);
    expect(
      assessBackupHealth(fresh, 7, '2026-09-21').state,
      'a just-taken backup must read as fresh',
    ).toBe('fresh');

    // Record count is unchanged — Phase 1 would still have called this fresh.
    await updateRecord(record.id, { title: '改过的标题' });

    const afterEdit = await getMeta();
    expect(afterEdit?.dataRevision).toBeGreaterThan(afterEdit?.lastBackupRevision ?? -1);
    const health = assessBackupHealth(afterEdit, 7, '2026-09-21');
    expect(health.state).toBe('stale');
    expect(health.state === 'stale' && health.reason).toBe('data-changed');
  });

  it('a settings change also marks the backup stale', async () => {
    await createWorkRecord(workInput());
    await recordCanonicalBackup({
      capturedRevision: (await getMeta())?.dataRevision ?? null,
      recordCount: 1,
    });
    await saveSettings({ ...(await getSettings()), appTitle: '改过的标题' });
    const meta = await getMeta();
    expect(assessBackupHealth(meta, 7, '2026-09-21').state).toBe('stale');
  });

  it('a rolled-back mutation does not advance the revision', async () => {
    await createWorkRecord(workInput());
    await recordCanonicalBackup({
      capturedRevision: (await getMeta())?.dataRevision ?? null,
      recordCount: 1,
    });
    const before = (await getMeta())?.dataRevision ?? 0;

    // An update to a non-existent record throws inside the transaction.
    await expect(updateRecord('no-such-id', { title: 'x' })).rejects.toThrow();

    expect((await getMeta())?.dataRevision).toBe(before);
    expect(assessBackupHealth(await getMeta(), 7, '2026-09-21').state).toBe('fresh');
  });

  it('an exact canonical restore leaves the backup state current, not stale', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    await applyImportPlan(await planFor(envelope, 'replace'));

    const meta = await getMeta();
    // The database now equals a backup the user holds, so nagging for another one is wrong.
    expect(meta?.lastBackupRevision).toBe(meta?.dataRevision);
    expect(assessBackupHealth(meta, 7, '2026-09-21').state).toBe('fresh');
  });
});
