import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  purgeAllDeleted,
  purgeRecord,
  softDeleteRecord,
  updateRecord,
} from '@/db/repositories/records';
import { getMeta, listCategories, listGroups } from '@/db/repositories/taxonomy';
import { readStoreSnapshot } from '@/db/snapshot';
import { ABSENT_DATE } from '@/domain/dates';
import { isHonorRecord, isWorkRecord } from '@/domain/types';
import { createBackup, readBackupSnapshot } from '@/services/backup';
import { buildEnvelope } from '@/services/backup/envelope';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan, planBlockers } from '@/services/import/plan';

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
 * Live relational integrity.
 *
 * Phase 1.2 validated relational integrity **at canonical restore time** and nowhere else, so an
 * ordinary user workflow could produce a live state that a freshly generated canonical backup could
 * not restore. The workflow is mundane: link an honour to a work record, then permanently delete the
 * work record from the Trash. Every stored row stays individually schema-valid, the backup declares
 * itself complete, backup health goes fresh — and restoring that same file is refused for a dangling
 * `relatedWorkId`.
 *
 * The first test below is that workflow end to end. It fails against
 * `48480cf47fc6b9a6f5974de808e39f1576286a46`.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-live-integrity-${String(counter)}`);
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

function honorInput(overrides: Record<string, unknown> = {}) {
  return {
    title: '示范荣誉',
    awardedOn: { kind: 'plain', date: '2026-06-20' } as const,
    honorType: '表彰（先进集体/个人）',
    level: '市级',
    issuingOrg: '示范颁发单位',
    documentNo: '',
    personalRole: '',
    evidenceLocation: '',
    relatedWorkId: null,
    remark: '',
    ...overrides,
  };
}

describe('PRIMARY BLOCKER: purging a work record referenced by an honour', () => {
  it('leaves no dangling relation, and the resulting backup is exact-restorable', async () => {
    // 1. A work record.
    const work = await createWorkRecord(workInput({ title: '被引用的工作事项' }));
    // 2. An honour linked to it.
    const honor = await createHonorRecord(
      honorInput({ title: '与该工作关联的荣誉', relatedWorkId: work.id }),
    );
    await addProgressEntry({ recordId: work.id, note: '工作进展一' });

    // 3. Soft-delete the work record (Trash).
    await softDeleteRecord(work.id);

    // 4. Permanently purge it through the repository path the Trash UI uses.
    const outcome = await purgeRecord(work.id);

    // The honour must survive, with its content intact...
    const after = await listRecords();
    const survivingHonor = after.records.find((record) => record.id === honor.id);
    expect(survivingHonor, 'the honour must not be deleted').toBeTruthy();
    expect(survivingHonor?.title).toBe('与该工作关联的荣誉');
    expect(isHonorRecord(survivingHonor!) && survivingHonor.issuingOrg).toBe('示范颁发单位');

    // ...and must no longer point at a record that does not exist.
    expect(
      isHonorRecord(survivingHonor!) && survivingHonor.relatedWorkId,
      'the reference must be detached, not left dangling',
    ).toBeNull();
    expect(outcome.honorsDetached, 'the operation reports what it detached').toBe(1);

    // 5. Every stored row is still individually schema-valid — which was true in Phase 1.2 too, and
    //    is exactly why row-level validation could not catch this.
    const snapshot = await readStoreSnapshot();
    expect(snapshot.invalid.records).toHaveLength(0);
    expect(snapshot.invalid.progressEntries).toHaveLength(0);

    // The work record and its progress are gone.
    expect(after.records.some((record) => record.id === work.id)).toBe(false);
    expect(await listProgressEntries()).toHaveLength(0);

    // 6. A canonical backup of this state must be complete...
    const backupSnapshot = await readBackupSnapshot();
    expect(backupSnapshot.complete, 'the live state must be backup-viable').toBe(true);
    expect(backupSnapshot.relationalIssues).toEqual([]);
    const result = await createBackup();
    expect(result.envelope.completeness).toBe('complete');
    expect(result.markedFresh).toBe(true);

    // 7. ...and restoring it must be permitted and exact. This is the assertion that fails against
    //    Phase 1.2, where the backup was complete and the restore was blocked by a dangling
    //    `relatedWorkId` — a file the application produced and then refused to accept.
    const plan = await buildImportPlan({
      parsed: result.envelope,
      mode: 'replace',
      existing: after.records,
      existingCategoryIds: (await destinationTaxonomy()).categories,
      existingGroupIds: (await destinationTaxonomy()).groups,
      existingProgressIds: [],
    });
    expect(plan.integrityIssues).toEqual([]);
    expect(planBlockers(plan), 'the backup it just wrote must be restorable').toEqual([]);
    expect(plan.exactRestorePossible).toBe(true);

    await applyImportPlan(plan);
    const restored = await listRecords();
    expect(restored.records.map((record) => record.id).sort()).toEqual([honor.id]);
  });

  it('bulk purge detaches every affected honour and stays relationally valid', async () => {
    const workA = await createWorkRecord(workInput({ title: '工作甲' }));
    const workB = await createWorkRecord(workInput({ title: '工作乙' }));
    const keep = await createWorkRecord(workInput({ title: '保留的工作' }));

    const honorA = await createHonorRecord(
      honorInput({ title: '荣誉甲', relatedWorkId: workA.id }),
    );
    const honorB = await createHonorRecord(
      honorInput({ title: '荣誉乙', relatedWorkId: workB.id }),
    );
    const honorKeep = await createHonorRecord(
      honorInput({ title: '仍有关联的荣誉', relatedWorkId: keep.id }),
    );
    await addProgressEntry({ recordId: workA.id, note: '甲的进展' });
    await addProgressEntry({ recordId: workB.id, note: '乙的进展' });

    await softDeleteRecord(workA.id);
    await softDeleteRecord(workB.id);

    const outcome = await purgeAllDeleted();
    expect(outcome.recordsPurged).toBe(2);
    expect(outcome.honorsDetached).toBe(2);

    const after = await listRecords();
    const byId = new Map(after.records.map((record) => [record.id, record]));
    const a = byId.get(honorA.id);
    const b = byId.get(honorB.id);
    const k = byId.get(honorKeep.id);
    expect(isHonorRecord(a!) && a.relatedWorkId).toBeNull();
    expect(isHonorRecord(b!) && b.relatedWorkId).toBeNull();
    // An honour whose work was not purged keeps its link.
    expect(isHonorRecord(k!) && k.relatedWorkId).toBe(keep.id);

    // Progress of the purged records is gone; the kept record's data is untouched.
    expect(await listProgressEntries()).toHaveLength(0);

    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });

  it('the purge mutation is atomic and bumps the revision exactly once', async () => {
    const work = await createWorkRecord(workInput());
    await createHonorRecord(honorInput({ relatedWorkId: work.id }));
    await addProgressEntry({ recordId: work.id, note: '进展' });
    await softDeleteRecord(work.id);

    const before = (await getMeta())?.dataRevision ?? 0;

    // Break the last write in the transaction. Everything before it must roll back together.
    const original = db.records.delete.bind(db.records);
    let failed = false;
    db.records.delete = () => {
      failed = true;
      throw new Error('injected failure');
    };

    try {
      await expect(purgeRecord(work.id)).rejects.toThrow();
    } finally {
      db.records.delete = original;
    }
    expect(failed).toBe(true);

    // Nothing changed: the honour still points at the work record, the progress is still there.
    const after = await listRecords();
    const honor = after.records.find(isHonorRecord);
    expect(honor?.relatedWorkId, 'the detach must roll back with the delete').toBe(work.id);
    expect(await listProgressEntries()).toHaveLength(1);
    expect(after.records.some((record) => record.id === work.id)).toBe(true);
    expect((await getMeta())?.dataRevision, 'a rolled-back mutation bumps nothing').toBe(before);

    // And the successful path bumps exactly once for the whole logical operation.
    await purgeRecord(work.id);
    expect((await getMeta())?.dataRevision).toBe(before + 1);
  });
});

describe('a relationally broken live store cannot produce a complete canonical backup', () => {
  /** Plant a dangling reference directly, bypassing the repository guards. */
  async function plantDanglingHonor(): Promise<void> {
    const work = await createWorkRecord(workInput());
    const honor = await createHonorRecord(honorInput({ relatedWorkId: work.id }));
    // Remove the work row behind the repository's back — the state Phase 1.2 could reach through
    // the Trash UI, and the state this suite must refuse to call backup-viable.
    await db.records.delete(work.id);
    expect((await listRecords()).records.map((r) => r.id)).toEqual([honor.id]);
  }

  it('REGRESSION: a dangling honour relation blocks a complete backup', async () => {
    await plantDanglingHonor();

    const snapshot = await readBackupSnapshot();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.relationalIssues.map((issue) => issue.kind)).toEqual(['dangling-related-work']);

    const { RelationalIntegrityError } = await import('@/services/backup');
    await expect(createBackup()).rejects.toBeInstanceOf(RelationalIntegrityError);

    // And it is not acknowledgeable: an "incomplete" label requires omission evidence, and there is
    // none — every row validates. Blocking is the only honest outcome.
    await expect(createBackup(new Date(), { acknowledgeOmissions: true })).rejects.toBeInstanceOf(
      RelationalIntegrityError,
    );

    const meta = await getMeta();
    expect(meta?.lastBackupAt, 'no backup may be recorded').toBeNull();
  });

  it('REGRESSION: an orphan progress entry blocks a complete backup', async () => {
    const work = await createWorkRecord(workInput());
    await addProgressEntry({ recordId: work.id, note: '进展' });
    await db.records.delete(work.id);

    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues.map((issue) => issue.kind)).toEqual(['orphan-progress']);
    expect(snapshot.complete).toBe(false);

    const { RelationalIntegrityError } = await import('@/services/backup');
    await expect(createBackup()).rejects.toBeInstanceOf(RelationalIntegrityError);
  });

  it('REGRESSION: a dangling category or group reference is diagnosed', async () => {
    const categories = await listCategories();
    const groups = await listGroups();
    const work = await createWorkRecord(
      workInput({ categoryId: categories[0]?.id ?? null, groupId: groups[0]?.id ?? null }),
    );
    expect(work.categoryId).toBeTruthy();

    // Delete the taxonomy rows behind the repository's back.
    await db.categories.delete(work.categoryId!);
    await db.groups.delete(work.groupId!);

    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues.map((issue) => issue.kind).sort()).toEqual([
      'dangling-category',
      'dangling-group',
    ]);
    expect(snapshot.complete).toBe(false);

    const { RelationalIntegrityError } = await import('@/services/backup');
    await expect(createBackup()).rejects.toBeInstanceOf(RelationalIntegrityError);
  });

  it('the diagnostic recovery export carries the structured relational issues', async () => {
    await plantDanglingHonor();
    const { buildRecoveryExport } = await import('@/services/backup/recovery');
    const recovery = await buildRecoveryExport('2026-09-21T09:00:00.000Z');
    expect(recovery.relationalIssues).toHaveLength(1);
    expect(recovery.relationalIssues[0]?.kind).toBe('dangling-related-work');
    expect(recovery.counts.relationalIssues).toBe(1);
  });
});

describe('ordinary mutations cannot create a dangling reference', () => {
  it('refuses a progress entry for a record that does not exist', async () => {
    await expect(addProgressEntry({ recordId: 'no-such-record', note: '进展' })).rejects.toThrow();
    expect(await listProgressEntries()).toHaveLength(0);
  });

  it('refuses an honour linked to a nonexistent work record', async () => {
    await expect(
      createHonorRecord(honorInput({ relatedWorkId: 'no-such-work' })),
    ).rejects.toThrow();
    expect((await listRecords()).records).toHaveLength(0);
  });

  it('refuses an honour linked to another honour', async () => {
    const other = await createHonorRecord(honorInput({ title: '另一个荣誉' }));
    await expect(createHonorRecord(honorInput({ relatedWorkId: other.id }))).rejects.toThrow();
  });

  it('refuses a work record with a nonexistent category or group', async () => {
    await expect(createWorkRecord(workInput({ categoryId: 'no-such-category' }))).rejects.toThrow();
    await expect(createWorkRecord(workInput({ groupId: 'no-such-group' }))).rejects.toThrow();
    expect((await listRecords()).records).toHaveLength(0);
  });

  it('refuses an edit that would dangle a reference', async () => {
    const work = await createWorkRecord(workInput());
    await expect(updateRecord(work.id, { categoryId: 'no-such-category' })).rejects.toThrow();
    await expect(updateRecord(work.id, { groupId: 'no-such-group' })).rejects.toThrow();

    const honor = await createHonorRecord(honorInput({ relatedWorkId: work.id }));
    await expect(updateRecord(honor.id, { relatedWorkId: 'no-such-work' })).rejects.toThrow();

    // The valid state is untouched.
    const after = await listRecords();
    const reread = after.records.find((record) => record.id === work.id);
    expect(isWorkRecord(reread!) && reread.categoryId).toBeNull();
  });

  it('a soft-deleted work record still satisfies an honour reference', async () => {
    // Soft delete is not deletion: the row is still there, still in backups, so the link is valid.
    const work = await createWorkRecord(workInput());
    await createHonorRecord(honorInput({ relatedWorkId: work.id }));
    await softDeleteRecord(work.id);

    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });

  it('a category still referenced by a soft-deleted record cannot be deleted', async () => {
    const { deleteCategoryIfUnused } = await import('@/db/repositories/taxonomy');
    const categories = await listCategories();
    const target = categories.find((category) => !category.builtIn) ?? categories[0];
    expect(target).toBeTruthy();
    const work = await createWorkRecord(workInput({ categoryId: target!.id }));
    await softDeleteRecord(work.id);

    expect(await deleteCategoryIfUnused(target!.id)).toBe(false);
    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues).toEqual([]);
  });

  it('deleting a group detaches its members rather than dangling them', async () => {
    const { addGroup, deleteGroup } = await import('@/db/repositories/taxonomy');
    const group = await addGroup('待删除的分组');
    const work = await createWorkRecord(workInput({ groupId: group.id }));

    const detached = await deleteGroup(group.id);
    expect(detached).toBe(1);

    const after = await listRecords();
    const updated = after.records.find((record) => record.id === work.id);
    expect(isWorkRecord(updated!) && updated.groupId).toBeNull();

    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });

  it('a complete backup of any reachable live state restores exactly', async () => {
    // A small but relationally interesting state, built only through repository calls.
    const categories = await listCategories();
    const groups = await listGroups();
    const work = await createWorkRecord(
      workInput({ categoryId: categories[0]?.id ?? null, groupId: groups[0]?.id ?? null }),
    );
    await addProgressEntry({ recordId: work.id, note: '进展' });
    await createHonorRecord(honorInput({ relatedWorkId: work.id }));
    const spare = await createWorkRecord(workInput({ title: '将被彻底删除' }));
    await softDeleteRecord(spare.id);
    await purgeRecord(spare.id);

    const snapshot = await readBackupSnapshot();
    expect(snapshot.complete).toBe(true);
    const envelope = await buildEnvelope(snapshot.input, '2026-09-21T09:00:00.000Z');
    const plan = await buildImportPlan({
      parsed: envelope,
      mode: 'replace',
      existing: (await listRecords()).records,
      existingCategoryIds: (await destinationTaxonomy()).categories,
      existingGroupIds: (await destinationTaxonomy()).groups,
      existingProgressIds: (await listProgressEntries()).map((entry) => entry.id),
    });
    expect(planBlockers(plan)).toEqual([]);
    expect(plan.exactRestorePossible).toBe(true);
  });
});
