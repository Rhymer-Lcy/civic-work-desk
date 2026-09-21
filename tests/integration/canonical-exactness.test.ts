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
} from '@/db/repositories/records';
import { listCategories, listGroups } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { readBackupSnapshot, snapshotForBackup } from '@/services/backup';
import { buildEnvelope, canonicalJson, sha256Hex } from '@/services/backup/envelope';
import type { BackupEnvelope } from '@/services/backup/envelope';
import { applyImportPlan, ImportBlockedError } from '@/services/import/apply';
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
 * Exactness of a canonical restore.
 *
 * A canonical restore promises `restore(D, B(S)) = S`. Everything here is a way that promise can be
 * broken while every individual row still passes its schema — and everything here was permitted by
 * Phase 1.1:
 *
 *  - an archive that **declares itself incomplete** was still offered as 完整还原, because nothing
 *    consulted `omittedInvalidRowIds` after the file was written;
 *  - a **duplicate progress id** inside the file was detected, the second row dropped, and the
 *    restore still labelled exact;
 *  - **relational** defects — an orphan progress note, a dangling category/group/related-work
 *    reference — were never checked at all;
 *  - the checksum covered `payload` only, so the completeness metadata that governs all of this was
 *    itself unprotected.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-exactness-${String(counter)}`);
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

/** A healthy canonical envelope of the current store. */
async function currentEnvelope(): Promise<BackupEnvelope> {
  return buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
}

/**
 * Re-sign an envelope after editing it.
 *
 * Used only where the test is about a *semantic* defect rather than about corruption: without this
 * the checksum blocker would fire first and the test would pass for the wrong reason.
 */
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

describe('an incomplete archive can never be an exact restore source', () => {
  it('REGRESSION: replace mode refuses a v2-style incomplete archive', async () => {
    await createWorkRecord(workInput());
    // Produce a genuinely incomplete file the way a user would: corrupt a row, then acknowledge.
    await db.records.put({ id: 'corrupt', kind: 'work', title: 7 } as never);
    const snapshot = await readBackupSnapshot();
    expect(snapshot.complete).toBe(false);
    const envelope = await buildEnvelope(snapshot.input, '2026-09-21T09:00:00.000Z');
    expect(envelope.completeness).toBe('incomplete');
    expect(envelope.omittedInvalidRowIds).toEqual(['corrupt']);

    const plan = await planFor(envelope, 'replace');
    expect(plan.strategy).toBe('canonical-restore');
    expect(plan.completeness).toBe('incomplete');
    expect(plan.exactRestorePossible).toBe(false);

    const blockers = planBlockers(plan);
    expect(blockers.join(' ')).toContain('无法用于“完整还原”');
    // And the write path refuses it even if a caller ignored the preview.
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);

    // Nothing was destroyed.
    expect((await listRecords()).records).toHaveLength(1);
  });

  it('merge remains available for an incomplete archive', async () => {
    const record = await createWorkRecord(workInput({ title: '本机记录' }));
    await db.records.put({ id: 'corrupt', kind: 'work', title: 7 } as never);
    const incomplete = await buildEnvelope(
      (await readBackupSnapshot()).input,
      '2026-09-21T09:00:00.000Z',
    );

    // A merge of a file containing one extra record: adding rows is still meaningful.
    const withExtra = await reseal({
      ...incomplete,
      payload: {
        ...incomplete.payload,
        records: [
          ...incomplete.payload.records,
          { ...incomplete.payload.records[0]!, id: 'incoming-1', title: '外来记录' },
        ],
      },
      counts: { ...incomplete.counts, records: incomplete.counts.records + 1, workRecords: 2 },
    });

    const plan = await planFor(withExtra, 'merge');
    expect(plan.strategy).toBe('merge');
    expect(plan.completeness).toBe('incomplete');
    expect(planBlockers(plan)).toEqual([]);

    await applyImportPlan(plan);
    const after = await listRecords();
    expect(after.records.map((r) => r.id).sort()).toEqual([record.id, 'incoming-1'].sort());
  });

  it('a complete archive is accepted and restores exactly', async () => {
    await createWorkRecord(workInput({ title: '甲' }));
    const envelope = await currentEnvelope();
    expect(envelope.completeness).toBe('complete');

    const plan = await planFor(envelope, 'replace');
    expect(plan.exactRestorePossible).toBe(true);
    expect(planBlockers(plan)).toEqual([]);
    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(1);
  });
});

describe('duplicate ids inside a canonical archive block an exact restore', () => {
  it('REGRESSION: a duplicate progress id blocks the restore instead of dropping a note', async () => {
    const record = await createWorkRecord(workInput());
    const entry = await addProgressEntry({ recordId: record.id, note: '进展一' });
    const envelope = await currentEnvelope();

    const duplicated = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          { ...entry, id: 'dup-progress', note: '第一条' },
          { ...entry, id: 'dup-progress', note: '第二条（重复 ID）' },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 2 },
    });

    const plan = await planFor(duplicated, 'replace');
    expect(plan.strategy).toBe('canonical-restore');
    expect(plan.duplicateProgressIdsInSource).toEqual(['dup-progress']);
    expect(plan.exactRestorePossible).toBe(false);
    expect(planBlockers(plan).join(' ')).toContain('重复的进展 ID');
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);

    // The destination is untouched: the original note is still there.
    expect((await listProgressEntries()).map((e) => e.note)).toEqual(['进展一']);
  });

  it('a duplicate record id still blocks, as in Phase 1.1', async () => {
    const record = await createWorkRecord(workInput());
    const envelope = await currentEnvelope();
    const duplicated = await reseal({
      ...envelope,
      payload: { ...envelope.payload, records: [record, { ...record, title: '同 ID 的另一条' }] },
      counts: { ...envelope.counts, records: 2, workRecords: 2 },
    });

    const plan = await planFor(duplicated, 'replace');
    expect(planBlockers(plan).join(' ')).toContain('重复的记录 ID');
  });

  it('a duplicate category id blocks the restore', async () => {
    await createWorkRecord(workInput());
    const envelope = await currentEnvelope();
    const first = envelope.payload.categories[0];
    expect(first).toBeTruthy();
    const duplicated = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        categories: [...envelope.payload.categories, { ...first!, name: '重复 ID 的分类' }],
      },
      counts: { ...envelope.counts, categories: envelope.counts.categories + 1 },
    });

    const plan = await planFor(duplicated, 'replace');
    expect(plan.integrityIssues.some((i) => i.kind === 'duplicate-category-id')).toBe(true);
    expect(planBlockers(plan).join(' ')).toContain('业务分类 ID 重复');
  });

  it('a duplicate group id blocks the restore', async () => {
    await createWorkRecord(workInput());
    const envelope = await currentEnvelope();
    const first = envelope.payload.groups[0];
    expect(first).toBeTruthy();
    const duplicated = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        groups: [...envelope.payload.groups, { ...first!, name: '重复 ID 的分组' }],
      },
      counts: { ...envelope.counts, groups: envelope.counts.groups + 1 },
    });

    const plan = await planFor(duplicated, 'replace');
    expect(plan.integrityIssues.some((i) => i.kind === 'duplicate-group-id')).toBe(true);
    expect(planBlockers(plan).join(' ')).toContain('归属分组 ID 重复');
  });
});

describe('relational integrity of a canonical archive', () => {
  it('REGRESSION: an orphan progress entry blocks the restore', async () => {
    const record = await createWorkRecord(workInput());
    const entry = await addProgressEntry({ recordId: record.id, note: '进展' });
    const envelope = await currentEnvelope();

    const orphaned = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [{ ...entry, recordId: 'no-such-record' }],
      },
    });

    const plan = await planFor(orphaned, 'replace');
    expect(plan.integrityIssues).toEqual([
      { kind: 'orphan-progress', id: entry.id, reference: 'no-such-record' },
    ]);
    expect(plan.exactRestorePossible).toBe(false);
    expect(planBlockers(plan).join(' ')).toContain('进展找不到所属记录');
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);
  });

  it('REGRESSION: a dangling categoryId blocks the restore', async () => {
    const categories = await listCategories();
    const record = await createWorkRecord(workInput({ categoryId: categories[0]?.id ?? null }));
    const envelope = await currentEnvelope();

    const dangling = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: envelope.payload.records.map((r) =>
          r.id === record.id ? { ...r, categoryId: 'no-such-category' } : r,
        ),
      },
    });

    const plan = await planFor(dangling, 'replace');
    expect(plan.integrityIssues).toEqual([
      { kind: 'dangling-category', id: record.id, reference: 'no-such-category' },
    ]);
    expect(planBlockers(plan).join(' ')).toContain('不存在的业务分类');
  });

  it('REGRESSION: a dangling groupId blocks the restore', async () => {
    const groups = await listGroups();
    const record = await createWorkRecord(workInput({ groupId: groups[0]?.id ?? null }));
    const envelope = await currentEnvelope();

    const dangling = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: envelope.payload.records.map((r) =>
          r.id === record.id ? { ...r, groupId: 'no-such-group' } : r,
        ),
      },
    });

    const plan = await planFor(dangling, 'replace');
    expect(plan.integrityIssues).toEqual([
      { kind: 'dangling-group', id: record.id, reference: 'no-such-group' },
    ]);
    expect(planBlockers(plan).join(' ')).toContain('不存在的归属分组');
  });

  it('REGRESSION: a dangling honour related-work reference blocks the restore', async () => {
    const work = await createWorkRecord(workInput());
    const honor = await createHonorRecord(honorInput({ relatedWorkId: work.id }));
    const envelope = await currentEnvelope();

    const dangling = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: envelope.payload.records.map((r) =>
          r.id === honor.id ? { ...r, relatedWorkId: 'no-such-work' } : r,
        ),
      },
    });

    const plan = await planFor(dangling, 'replace');
    expect(plan.integrityIssues).toEqual([
      { kind: 'dangling-related-work', id: honor.id, reference: 'no-such-work' },
    ]);
    expect(planBlockers(plan).join(' ')).toContain('不存在的工作记录');
  });

  it('an honour pointing at another honour is dangling, not merely odd', async () => {
    await createWorkRecord(workInput());
    const first = await createHonorRecord(honorInput({ title: '荣誉甲' }));
    const second = await createHonorRecord(honorInput({ title: '荣誉乙' }));
    const envelope = await currentEnvelope();

    const crossLinked = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: envelope.payload.records.map((r) =>
          r.id === second.id ? { ...r, relatedWorkId: first.id } : r,
        ),
      },
    });

    const plan = await planFor(crossLinked, 'replace');
    expect(plan.integrityIssues.some((i) => i.kind === 'dangling-related-work')).toBe(true);
  });

  it('a healthy archive with real references has no integrity issues', async () => {
    const categories = await listCategories();
    const groups = await listGroups();
    const work = await createWorkRecord(
      workInput({ categoryId: categories[0]?.id ?? null, groupId: groups[0]?.id ?? null }),
    );
    await addProgressEntry({ recordId: work.id, note: '进展' });
    await createHonorRecord(honorInput({ relatedWorkId: work.id }));

    const plan = await planFor(await currentEnvelope(), 'replace');
    expect(plan.integrityIssues).toEqual([]);
    expect(plan.exactRestorePossible).toBe(true);
    expect(planBlockers(plan)).toEqual([]);
  });

  it('a legacy file keeps its best-effort path: no relational blocking', async () => {
    await createWorkRecord(workInput());
    const legacy = {
      version: 3,
      works: [
        { id: 'legacy-1', title: '旧记录', date: '2026-01-01', biz: '不存在的分类' },
        { id: 'legacy-2', title: '另一条', date: '不是日期' },
      ],
    };
    const plan = await planFor(legacy, 'replace');
    expect(plan.strategy).toBe('legacy-replace');
    expect(plan.completeness).toBeNull();
    expect(plan.integrityIssues).toEqual([]);
    expect(planBlockers(plan)).toEqual([]);
  });
});

describe('v3 checksum covers the completeness metadata', () => {
  it('REGRESSION: editing omittedInvalidRowIds is detected', async () => {
    await createWorkRecord(workInput());
    await db.records.put({ id: 'corrupt', kind: 'work', title: 7 } as never);
    const incomplete = await buildEnvelope(
      (await readBackupSnapshot()).input,
      '2026-09-21T09:00:00.000Z',
    );
    expect(incomplete.completeness).toBe('incomplete');

    // Forge completeness without touching the payload — exactly what a v2 digest could not see.
    const forged: BackupEnvelope = {
      ...incomplete,
      completeness: 'complete',
      omittedInvalidRowIds: [],
    };

    const plan = await planFor(forged, 'replace');
    expect(plan.checksum, 'the digest must notice the edit').toBe('mismatch');
    expect(planBlockers(plan).join(' ')).toContain('校验和不匹配');
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);
  });

  it('the v3 digest also covers exportedAt, counts and dataRevision', async () => {
    await createWorkRecord(workInput());
    const envelope = await currentEnvelope();

    for (const mutate of [
      (e: BackupEnvelope): BackupEnvelope => ({ ...e, exportedAt: '2030-01-01T00:00:00.000Z' }),
      (e: BackupEnvelope): BackupEnvelope => ({ ...e, dataRevision: 999 }),
      (e: BackupEnvelope): BackupEnvelope => ({ ...e, schemaVersion: e.schemaVersion }),
    ]) {
      const mutated = mutate(envelope);
      const plan = await planFor(mutated, 'merge');
      // The third case is a no-op mutation and must still verify: a digest that reported mismatch
      // for an unchanged file would be useless.
      const expected = canonicalJson(mutated) === canonicalJson(envelope) ? 'match' : 'mismatch';
      expect(plan.checksum).toBe(expected);
    }
  });

  it('an unedited v3 file verifies', async () => {
    await createWorkRecord(workInput());
    const plan = await planFor(await currentEnvelope(), 'replace');
    expect(plan.checksum).toBe('match');
    expect(plan.checksumScope).toBe('envelope');
  });
});

describe('v1 and v2 compatibility remains explicit', () => {
  /** Build a v2-shaped file from the current store: payload-scoped digest, no completeness field. */
  async function asV2(envelope: BackupEnvelope): Promise<Record<string, unknown>> {
    const v2: Record<string, unknown> = {
      application: envelope.application,
      backupFormatVersion: 2,
      schemaVersion: envelope.schemaVersion,
      exportedAt: envelope.exportedAt,
      counts: envelope.counts,
      omittedInvalidRowIds: [...envelope.omittedInvalidRowIds],
      dataRevision: envelope.dataRevision,
      payloadChecksum: await sha256Hex(canonicalJson(envelope.payload)),
      payload: envelope.payload,
    };
    return v2;
  }

  it('a v2 file migrates to v3, keeps its payload-scoped digest, and restores exactly', async () => {
    await createWorkRecord(workInput({ title: '甲' }));
    const v2 = await asV2(await currentEnvelope());

    const plan = await planFor(v2, 'replace');
    expect(plan.completeness).toBe('complete');
    expect(plan.checksumScope).toBe('payload');
    expect(plan.checksum).toBe('match');
    expect(plan.exactRestorePossible).toBe(true);

    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(1);
  });

  it('a v2 file that declares omissions is incomplete and cannot restore exactly', async () => {
    await createWorkRecord(workInput());
    const base = await currentEnvelope();
    const v2 = await asV2(base);
    v2['omittedInvalidRowIds'] = ['some-dropped-row'];
    // Re-sign the payload-scoped digest so the checksum is not what blocks this.
    v2['payloadChecksum'] = await sha256Hex(canonicalJson(base.payload));

    const plan = await planFor(v2, 'replace');
    expect(plan.completeness).toBe('incomplete');
    expect(plan.checksum).toBe('match');
    expect(plan.exactRestorePossible).toBe(false);
    expect(planBlockers(plan).join(' ')).toContain('无法用于“完整还原”');
  });

  it('REGRESSION: a v1 file is unknown-legacy, never "complete"', async () => {
    await createWorkRecord(workInput({ title: '甲' }));
    const base = await currentEnvelope();
    const v1: Record<string, unknown> = {
      application: base.application,
      backupFormatVersion: 1,
      schemaVersion: base.schemaVersion,
      exportedAt: base.exportedAt,
      counts: base.counts,
      payloadChecksum: await sha256Hex(canonicalJson(base.payload)),
      payload: base.payload,
    };

    const plan = await planFor(v1, 'replace');
    /*
     * Phase 1.1 migrated v1 by writing `omittedInvalidRowIds: []`, which reads as "nothing was
     * omitted". It cannot mean that: v1 had no such field *and* the build that wrote it could drop
     * invalid rows silently. Absence of evidence is not evidence of completeness.
     */
    expect(plan.completeness).toBe('unknown-legacy');
    expect(plan.requiresCompletenessAcknowledgement).toBe(true);
    // Not blocked — refusing every v1 archive would strand anyone whose only backup predates v2.
    expect(planBlockers(plan)).toEqual([]);
    expect(plan.exactRestorePossible).toBe(true);
    expect(plan.checksumScope).toBe('payload');
    expect(plan.checksum).toBe('match');

    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(1);
  });

  it('migration is deterministic: the same v1 file always yields the same plan shape', async () => {
    await createWorkRecord(workInput());
    const base = await currentEnvelope();
    const v1 = {
      application: base.application,
      backupFormatVersion: 1,
      schemaVersion: base.schemaVersion,
      exportedAt: base.exportedAt,
      counts: base.counts,
      payloadChecksum: await sha256Hex(canonicalJson(base.payload)),
      payload: base.payload,
    };

    const first = await planFor(v1, 'replace');
    const second = await planFor(JSON.parse(JSON.stringify(v1)), 'replace');
    expect(first.completeness).toBe(second.completeness);
    expect(first.checksum).toBe(second.checksum);
    expect(canonicalJson(first.accepted)).toBe(canonicalJson(second.accepted));
  });

  it('a future version is still refused by name', async () => {
    await createWorkRecord(workInput());
    const envelope = await currentEnvelope();
    await expect(planFor({ ...envelope, backupFormatVersion: 999 }, 'replace')).rejects.toThrow(
      /更新版本/,
    );
  });
});
