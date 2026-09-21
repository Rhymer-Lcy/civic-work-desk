import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  createWorkRecord,
  listProgressEntries,
  listRecords,
  purgeRecord,
  softDeleteRecord,
} from '@/db/repositories/records';
import {
  addCategory,
  addGroup,
  getMeta,
  getSettings,
  listCategories,
  listGroups,
  saveSettings,
} from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { assessBackupHealth, createBackup, snapshotForBackup } from '@/services/backup';
import { buildEnvelope, canonicalJson, sha256Hex } from '@/services/backup/envelope';
import type { BackupEnvelope } from '@/services/backup/envelope';
import { ImportParseError, buildImportPlan, planBlockers } from '@/services/import/plan';
import { applyImportPlan, ImportBlockedError } from '@/services/import/apply';

/**
 * What backup health is allowed to conclude, and what a v3 envelope is allowed to claim.
 *
 * Phase 1.2 short-circuited backup health to `fresh` whenever the count of **live** records was zero.
 * That is not a statement about whether anything is worth keeping: a database whose every record sits
 * in the Trash, or which has custom categories, or edited settings, or which held records and was
 * emptied, all have zero live records and real user data — all of it carried in canonical backups. The
 * application reported 今天已备份 while holding data no backup contained.
 *
 * The rule is now the revision model alone: only a genuinely pristine database (`dataRevision === 0`,
 * never backed up) avoids nagging.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-health-scope-${String(counter)}`);
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

async function health() {
  return assessBackupHealth(await getMeta(), 7, '2026-09-21');
}

/** Live (non-deleted) records, the count Phase 1.2 used to short-circuit on. */
async function liveCount(): Promise<number> {
  const { records } = await listRecords();
  return records.filter((record) => record.deletedAt === null).length;
}

describe('zero live records does not by itself suppress a backup warning', () => {
  it('REGRESSION: every record soft-deleted still needs a backup', async () => {
    const record = await createWorkRecord(workInput());
    await softDeleteRecord(record.id);

    expect(await liveCount(), 'the precondition Phase 1.2 short-circuited on').toBe(0);
    // A trashed record is user data and is included in canonical backups, so the state is unbacked.
    expect((await health()).state).toBe('never');

    // And it really is in the backup, which is why suppressing the warning was wrong.
    const snapshot = await snapshotForBackup();
    expect(snapshot.records).toHaveLength(1);
  });

  it('REGRESSION: a settings-only change with no records still needs a backup', async () => {
    const settings = await getSettings();
    await saveSettings({ ...settings, appTitle: '改过的应用标题' });

    expect(await liveCount()).toBe(0);
    expect((await health()).state).toBe('never');
  });

  it('REGRESSION: a category-only change with no records still needs a backup', async () => {
    await addCategory('新增的业务分类');
    expect(await liveCount()).toBe(0);
    expect((await health()).state).toBe('never');
  });

  it('REGRESSION: a group-only change with no records still needs a backup', async () => {
    await addGroup('新增的归属分组');
    expect(await liveCount()).toBe(0);
    expect((await health()).state).toBe('never');
  });

  it('REGRESSION: create then permanently delete leaves the backup state stale, not fresh', async () => {
    const record = await createWorkRecord(workInput());
    await createBackup();
    expect((await health()).state).toBe('fresh');

    await softDeleteRecord(record.id);
    await purgeRecord(record.id);

    expect(await liveCount()).toBe(0);
    const state = await health();
    // The data moved on after the backup was taken; an empty store is not a backed-up store.
    expect(state.state).toBe('stale');
    expect(state.state === 'stale' && state.reason).toBe('data-changed');
  });

  it('a genuinely pristine first run does not nag', async () => {
    // Seeding writes the default taxonomy and settings without touching the revision counter, so this
    // is the one state with nothing to lose.
    const meta = await getMeta();
    expect(meta?.dataRevision).toBe(0);
    expect(meta?.lastBackupAt).toBeNull();
    expect((await health()).state).toBe('pristine');
  });

  it('a backup taken after a settings-only change goes fresh again', async () => {
    const settings = await getSettings();
    await saveSettings({ ...settings, appTitle: '改过的应用标题' });
    await createBackup();
    expect((await health()).state).toBe('fresh');

    // ...and a further change makes it stale, with zero records throughout.
    await addCategory('又一个分类');
    expect(await liveCount()).toBe(0);
    expect((await health()).state).toBe('stale');
  });
});

describe('a v3 envelope may not contradict itself', () => {
  async function planFor(parsed: unknown, mode: 'merge' | 'replace') {
    const [{ records }, progress, categories, groups] = await Promise.all([
      listRecords(),
      listProgressEntries(),
      listCategories(),
      listGroups(),
    ]);
    return buildImportPlan({
      parsed,
      mode,
      existing: records,
      existingProgressIds: progress.map((entry) => entry.id),
      existingCategoryIds: categories.map((category) => category.id),
      existingGroupIds: groups.map((group) => group.id),
    });
  }

  async function reseal(envelope: BackupEnvelope): Promise<BackupEnvelope> {
    const rest: Record<string, unknown> = { ...envelope };
    delete rest['checksum'];
    return {
      ...(rest as unknown as Omit<BackupEnvelope, 'checksum'>),
      checksum: {
        algorithm: 'sha-256',
        scope: 'envelope',
        value: await sha256Hex(canonicalJson(rest)),
      },
    };
  }

  it('REGRESSION: "complete" with a non-empty omission list is refused, checksum notwithstanding', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');

    // Contradictory, then re-signed so the digest matches perfectly. Shape, counts and checksum are
    // all valid; only the meaning is impossible.
    const forged = await reseal({
      ...envelope,
      completeness: 'complete' as const,
      omittedInvalidRowIds: ['some-dropped-row'],
    });

    await expect(planFor(forged, 'replace')).rejects.toBeInstanceOf(ImportParseError);
    await expect(planFor(forged, 'replace')).rejects.toThrow(/自相矛盾/);
    // Merge is refused too: an untrustworthy file is untrustworthy in every mode.
    await expect(planFor(forged, 'merge')).rejects.toBeInstanceOf(ImportParseError);
  });

  it('REGRESSION: "incomplete" with no omission evidence is refused', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const forged = await reseal({
      ...envelope,
      completeness: 'incomplete' as const,
      omittedInvalidRowIds: [],
    });

    await expect(planFor(forged, 'replace')).rejects.toThrow(/自相矛盾/);
  });

  it('a coherent incomplete envelope is still readable, and still refused for exact restore', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const coherent = await reseal({
      ...envelope,
      completeness: 'incomplete' as const,
      omittedInvalidRowIds: ['a-genuinely-dropped-row'],
    });

    const plan = await planFor(coherent, 'replace');
    expect(plan.completeness).toBe('incomplete');
    expect(plan.exactRestorePossible).toBe(false);
    expect(planBlockers(plan).join(' ')).toContain('无法用于“完整还原”');
  });

  it('a coherent complete envelope is accepted', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const plan = await planFor(envelope, 'replace');
    expect(plan.completeness).toBe('complete');
    expect(planBlockers(plan)).toEqual([]);
  });

  it('a v1 archive keeps unknown-legacy with an empty omission list', async () => {
    await createWorkRecord(workInput());
    const base = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const v1: Record<string, unknown> = {
      application: base.application,
      backupFormatVersion: 1,
      schemaVersion: base.schemaVersion,
      exportedAt: base.exportedAt,
      counts: base.counts,
      payloadChecksum: await sha256Hex(canonicalJson(base.payload)),
      payload: base.payload,
    };

    // `unknown-legacy` is exempt from the equivalence: v1 had no omission list, so an empty one there
    // is the absence of evidence rather than a claim of completeness.
    const plan = await planFor(v1, 'replace');
    expect(plan.completeness).toBe('unknown-legacy');
    expect(planBlockers(plan)).toEqual([]);
  });
});

describe('a destructive legacy replace must have something to write', () => {
  it('REGRESSION: an all-invalid legacy source cannot clear a populated destination', async () => {
    const keep = await createWorkRecord(workInput({ title: '必须保留的记录' }));
    const before = (await listRecords()).records.length;
    expect(before).toBe(1);

    // Every row unimportable: no title at all, so each is rejected by the normaliser.
    const hostile = {
      version: 3,
      works: [{ id: 'bad-1', title: '' }, { id: 'bad-2' }, { notEvenARecord: true }],
    };

    const [{ records }, progress, categories, groups] = await Promise.all([
      listRecords(),
      listProgressEntries(),
      listCategories(),
      listGroups(),
    ]);
    const plan = await buildImportPlan({
      parsed: hostile,
      mode: 'replace',
      existing: records,
      existingProgressIds: progress.map((entry) => entry.id),
      existingCategoryIds: categories.map((category) => category.id),
      existingGroupIds: groups.map((group) => group.id),
    });

    expect(plan.strategy).toBe('legacy-replace');
    expect(plan.accepted).toHaveLength(0);
    expect(plan.summary.rejected).toBeGreaterThan(0);

    const blockers = planBlockers(plan);
    expect(blockers.join(' ')).toContain('无法用于“替换”');
    expect(blockers.join(' ')).toContain('清空全部本机数据');

    // The write path refuses it even if a caller ignored the preview...
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);
    // ...and the destination is untouched.
    const after = await listRecords();
    expect(after.records).toHaveLength(1);
    expect(after.records[0]?.id).toBe(keep.id);
  });

  it('a legacy replace that does bring records still works', async () => {
    await createWorkRecord(workInput({ title: '将被替换的记录' }));
    const legacy = {
      version: 3,
      works: [{ id: 'legacy-1', title: '替换进来的记录', date: '2026-01-01' }],
    };
    const [{ records }, progress, categories, groups] = await Promise.all([
      listRecords(),
      listProgressEntries(),
      listCategories(),
      listGroups(),
    ]);
    const plan = await buildImportPlan({
      parsed: legacy,
      mode: 'replace',
      existing: records,
      existingProgressIds: progress.map((entry) => entry.id),
      existingCategoryIds: categories.map((category) => category.id),
      existingGroupIds: groups.map((group) => group.id),
    });
    expect(planBlockers(plan)).toEqual([]);
    await applyImportPlan(plan);
    expect((await listRecords()).records.map((record) => record.id)).toEqual(['legacy-1']);
  });

  it('a canonical restore of a legitimately empty backup is still allowed', async () => {
    // Not the same case: a verified-complete archive of an empty database is a real archive, and
    // restoring it is a real operation. Only a legacy file with nothing importable is refused.
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    expect(envelope.completeness).toBe('complete');
    await createWorkRecord(workInput({ title: '将被清除的记录' }));

    const [{ records }, progress, categories, groups] = await Promise.all([
      listRecords(),
      listProgressEntries(),
      listCategories(),
      listGroups(),
    ]);
    const plan = await buildImportPlan({
      parsed: envelope,
      mode: 'replace',
      existing: records,
      existingProgressIds: progress.map((entry) => entry.id),
      existingCategoryIds: categories.map((category) => category.id),
      existingGroupIds: groups.map((group) => group.id),
    });
    expect(plan.strategy).toBe('canonical-restore');
    expect(planBlockers(plan)).toEqual([]);
    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(0);
  });
});
