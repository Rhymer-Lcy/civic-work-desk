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
import { addCategory, addGroup, listCategories, listGroups } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { isHonorRecord, isWorkRecord } from '@/domain/types';
import { snapshotForBackup } from '@/services/backup';
import { buildEnvelope, canonicalJson, sha256Hex } from '@/services/backup/envelope';
import type { BackupEnvelope } from '@/services/backup/envelope';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan, planBlockers } from '@/services/import/plan';

/**
 * Merge semantics under the projected-final-state model.
 *
 * Phase 1.2 judged an incoming reference against the wrong thing. A progress entry was accepted only
 * when its record was *newly accepted from the same file*, so the commonest real merge — a new note
 * for a record the destination already holds — was silently skipped. And nothing at all was checked
 * for an incoming record's category, group or related-work reference, so a merge could introduce
 * exactly the dangling reference a canonical restore refuses.
 *
 * Both are the same mistake: judging a reference against a fragment rather than against
 * `finalState = destination + acceptedChanges`.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-merge-semantics-${String(counter)}`);
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

/** Re-seal an edited envelope so a semantic test is not stopped by the checksum first. */
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

/** A plan built with the destination truthfully declared. */
async function mergePlan(parsed: unknown) {
  const [{ records }, progress, categories, groups] = await Promise.all([
    listRecords(),
    listProgressEntries(),
    listCategories(),
    listGroups(),
  ]);
  return buildImportPlan({
    parsed,
    mode: 'merge',
    existing: records,
    existingProgressIds: progress.map((entry) => entry.id),
    existingCategoryIds: categories.map((category) => category.id),
    existingGroupIds: groups.map((group) => group.id),
  });
}

describe('progress merges against the projected final state', () => {
  it('REGRESSION: a new note for a record the destination already has is merged', async () => {
    // The destination holds R. The incoming file carries a new note for R, and R itself is a conflict
    // because it already exists — which is precisely why Phase 1.2 skipped the note.
    const record = await createWorkRecord(workInput({ title: '本机已有的记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');

    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'incoming-progress-1',
            recordId: record.id,
            occurredOn: ABSENT_DATE,
            note: '来自备份的新进展',
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });

    const plan = await mergePlan(incoming);
    expect(plan.strategy).toBe('merge');
    // The record is a conflict and is skipped, as always...
    expect(plan.conflicts.map((conflict) => conflict.id)).toEqual([record.id]);
    // ...but its note is genuinely new and must be written.
    expect(plan.acceptedProgress.map((entry) => entry.id)).toEqual(['incoming-progress-1']);
    expect(plan.orphanProgress).toEqual([]);
    expect(planBlockers(plan)).toEqual([]);

    await applyImportPlan(plan);
    const notes = await listProgressEntries();
    expect(notes.map((entry) => entry.note)).toEqual(['来自备份的新进展']);
    expect(notes[0]?.recordId).toBe(record.id);
  });

  it('a note for a record arriving in the same file is merged', async () => {
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const template = envelope.payload.records[0];
    expect(template).toBeTruthy();

    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [{ ...template!, id: 'incoming-record', title: '外来记录' }],
        progressEntries: [
          {
            id: 'incoming-progress-2',
            recordId: 'incoming-record',
            occurredOn: ABSENT_DATE,
            note: '外来记录的进展',
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, records: 1, workRecords: 1, progressEntries: 1 },
    });

    const plan = await mergePlan(incoming);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);
    expect(plan.acceptedProgress.map((entry) => entry.id)).toEqual(['incoming-progress-2']);
    await applyImportPlan(plan);
    expect((await listProgressEntries()).map((entry) => entry.recordId)).toEqual([
      'incoming-record',
    ]);
  });

  it('a progress id that collides with the destination is reported, never overwritten', async () => {
    const record = await createWorkRecord(workInput());
    const local = await addProgressEntry({ recordId: record.id, note: '本机原有进展' });
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');

    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [{ ...local, note: '外来的同 ID 进展' }],
      },
    });

    const plan = await mergePlan(incoming);
    expect(plan.progressCollisions).toHaveLength(1);
    expect(plan.progressCollisions[0]?.reason).toBe('exists-in-destination');
    expect(plan.acceptedProgress).toHaveLength(0);

    await applyImportPlan(plan);
    expect((await listProgressEntries()).map((entry) => entry.note)).toEqual(['本机原有进展']);
  });

  it('duplicate progress ids inside the source never collapse silently', async () => {
    const record = await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const base = {
      id: 'dup',
      recordId: record.id,
      occurredOn: ABSENT_DATE,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    };
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          { ...base, note: '第一条' },
          { ...base, note: '第二条（重复 ID）' },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 2 },
    });

    const plan = await mergePlan(incoming);
    expect(plan.duplicateProgressIdsInSource).toEqual(['dup']);
    expect(plan.progressCollisions[0]?.reason).toBe('duplicate-in-source');
    expect(plan.acceptedProgress).toHaveLength(1);
    await applyImportPlan(plan);
    expect((await listProgressEntries()).filter((entry) => entry.id === 'dup')).toHaveLength(1);
  });

  it('a note whose record exists nowhere is reported as an orphan and skipped', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'orphan-note',
            recordId: 'no-such-record',
            occurredOn: ABSENT_DATE,
            note: '无主进展',
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });

    const plan = await mergePlan(incoming);
    expect(plan.orphanProgress).toEqual([{ id: 'orphan-note', recordId: 'no-such-record' }]);
    expect(plan.acceptedProgress).toHaveLength(0);
    await applyImportPlan(plan);
    expect(await listProgressEntries()).toHaveLength(0);
  });
});

describe('merge cannot introduce a dangling reference', () => {
  /** An envelope carrying one work record that points at ids the file does not contain. */
  async function envelopeWithReferences(overrides: Record<string, unknown>) {
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    // Narrowed to a work record: only a work record carries `categoryId`/`groupId`.
    const template = envelope.payload.records.find(isWorkRecord);
    expect(template).toBeTruthy();
    return reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [{ ...template!, id: 'incoming-record', title: '外来记录', ...overrides }],
        // The file brings no taxonomy of its own, so the reference can only resolve locally.
        categories: [],
        groups: [],
      },
      counts: { ...envelope.counts, records: 1, workRecords: 1, categories: 0, groups: 0 },
    });
  }

  it('REGRESSION: a category that exists in neither the file nor the destination is refused', async () => {
    const incoming = await envelopeWithReferences({ categoryId: 'no-such-category' });
    const plan = await mergePlan(incoming);

    expect(plan.accepted, 'the row must not be written').toHaveLength(0);
    expect(plan.referenceRejections).toHaveLength(1);
    expect(plan.referenceRejections[0]?.reason).toContain('业务分类');
    expect(plan.summary.referenceRejections).toBe(1);

    await applyImportPlan(plan).catch(() => undefined);
    const after = await listRecords();
    expect(after.records.some((record) => record.id === 'incoming-record')).toBe(false);
    // And the reference was not quietly rewritten to null to make the row acceptable.
    expect(after.records.every((record) => record.id !== 'incoming-record')).toBe(true);
  });

  it('REGRESSION: a group that exists nowhere is refused', async () => {
    const incoming = await envelopeWithReferences({ groupId: 'no-such-group' });
    const plan = await mergePlan(incoming);
    expect(plan.accepted).toHaveLength(0);
    expect(plan.referenceRejections[0]?.reason).toContain('归属分组');
  });

  it('REGRESSION: an honour pointing at a work record that exists nowhere is refused', async () => {
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [
          ...envelope.payload.records,
          {
            id: 'incoming-honor',
            kind: 'honor' as const,
            title: '外来荣誉',
            awardedOn: { kind: 'plain' as const, date: '2026-06-20' },
            honorType: '表彰（先进集体/个人）',
            level: '市级',
            issuingOrg: '示范颁发单位',
            documentNo: '',
            personalRole: '',
            evidenceLocation: '',
            relatedWorkId: 'no-such-work',
            remark: '',
            legacyResidue: null,
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
            deletedAt: null,
          },
        ],
      },
      counts: { ...envelope.counts, records: 2, honorRecords: 1 },
    });

    const plan = await mergePlan(incoming);
    expect(plan.accepted.some((record) => record.id === 'incoming-honor')).toBe(false);
    expect(plan.referenceRejections[0]?.reason).toContain('关联工作记录');
  });

  it('a reference that resolves in the destination is accepted', async () => {
    // The same shape as the refusals above, except the category genuinely exists locally. This is the
    // case Phase 1.2 could not distinguish, because it checked nothing.
    const category = await addCategory('本机新增分类');
    const group = await addGroup('本机新增分组');
    const incoming = await envelopeWithReferences({
      categoryId: category.id,
      groupId: group.id,
    });

    const plan = await mergePlan(incoming);
    expect(plan.referenceRejections).toEqual([]);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);

    await applyImportPlan(plan);
    const written = (await listRecords()).records.find((r) => r.id === 'incoming-record');
    expect(isWorkRecord(written!) && written.categoryId).toBe(category.id);
  });

  it('a reference satisfied by taxonomy arriving in the same file is accepted', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const template = envelope.payload.records.find(isWorkRecord);
    expect(template).toBeTruthy();
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [
          { ...template!, id: 'incoming-record', title: '外来记录', categoryId: 'file-category' },
        ],
        categories: [
          ...envelope.payload.categories,
          {
            id: 'file-category',
            name: '文件带来的分类',
            sortOrder: 99,
            builtIn: false,
            archived: false,
          },
        ],
      },
      counts: {
        ...envelope.counts,
        records: 1,
        workRecords: 1,
        categories: envelope.counts.categories + 1,
      },
    });

    const plan = await mergePlan(incoming);
    expect(plan.referenceRejections).toEqual([]);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);
    await applyImportPlan(plan);
    expect((await listCategories()).some((category) => category.id === 'file-category')).toBe(true);
  });

  it('REGRESSION: an incomplete archive cannot be merged into a dangling state', async () => {
    /*
     * The §9 scenario. A corrupt category was omitted from the archive, but a perfectly valid work
     * record still references it, and the destination does not have it either. Accepting that record
     * would create the dangling reference; rewriting its category to null would alter the user's data;
     * inventing the category would invent taxonomy. It is refused, with the reason stated.
     */
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const template = envelope.payload.records.find(isWorkRecord);
    expect(template).toBeTruthy();

    const incomplete = await reseal({
      ...envelope,
      completeness: 'incomplete' as const,
      omittedInvalidRowIds: ['corrupt-category'],
      payload: {
        ...envelope.payload,
        records: [
          {
            ...template!,
            id: 'incoming-record',
            title: '外来记录',
            categoryId: 'corrupt-category',
          },
        ],
      },
      counts: { ...envelope.counts, records: 1, workRecords: 1 },
    });

    const plan = await mergePlan(incomplete);
    expect(plan.completeness).toBe('incomplete');
    expect(plan.referenceRejections).toHaveLength(1);
    expect(plan.referenceRejections[0]?.id).toBe('incoming-record');
    expect(plan.accepted).toHaveLength(0);
  });

  it('a merge that writes nothing but has conflicts is not treated as an error', async () => {
    // Re-importing the destination's own backup: everything conflicts, nothing is rejected.
    await createWorkRecord(workInput());
    await createHonorRecord(honorInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const plan = await mergePlan(envelope);
    expect(plan.referenceRejections).toEqual([]);
    expect(plan.conflicts).toHaveLength(2);
    expect(plan.accepted).toHaveLength(0);
    expect(planBlockers(plan)).toEqual([]);
  });

  it('an honour linked to a work record in the same file merges correctly', async () => {
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const template = envelope.payload.records[0];
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [
          // Deliberately honour-first, to prove the planner does not depend on file order.
          {
            id: 'incoming-honor',
            kind: 'honor' as const,
            title: '外来荣誉',
            awardedOn: { kind: 'plain' as const, date: '2026-06-20' },
            honorType: '表彰（先进集体/个人）',
            level: '市级',
            issuingOrg: '示范颁发单位',
            documentNo: '',
            personalRole: '',
            evidenceLocation: '',
            relatedWorkId: 'incoming-work',
            remark: '',
            legacyResidue: null,
            createdAt: '2026-09-20T00:00:00.000Z',
            updatedAt: '2026-09-20T00:00:00.000Z',
            deletedAt: null,
          },
          { ...template!, id: 'incoming-work', title: '外来工作' },
        ],
      },
      counts: { ...envelope.counts, records: 2, workRecords: 1, honorRecords: 1 },
    });

    const plan = await mergePlan(incoming);
    expect(plan.referenceRejections).toEqual([]);
    expect(plan.accepted.map((record) => record.id).sort()).toEqual(
      ['incoming-honor', 'incoming-work'].sort(),
    );

    await applyImportPlan(plan);
    const honor = (await listRecords()).records.find((record) => record.id === 'incoming-honor');
    expect(isHonorRecord(honor!) && honor.relatedWorkId).toBe('incoming-work');
  });
});
