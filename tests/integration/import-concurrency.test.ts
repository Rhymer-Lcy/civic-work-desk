import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { Transaction } from 'dexie';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  purgeRecord,
  softDeleteRecord,
} from '@/db/repositories/records';
import {
  addCategory,
  addGroup,
  deleteCategoryIfUnused,
  deleteGroup,
  getMeta,
  getSettings,
  listCategories,
  listGroups,
  saveSettings,
} from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { validateRelationalIntegrity } from '@/domain/integrity';
import { isWorkRecord } from '@/domain/types';
import { snapshotForBackup } from '@/services/backup';
import { buildEnvelope, canonicalJson, sha256Hex } from '@/services/backup/envelope';
import type { BackupEnvelope } from '@/services/backup/envelope';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan, planBlockers } from '@/services/import/plan';
import { StaleImportPlanError } from '@/services/import/preflight';
import { BUILT_IN_CATEGORY_IDS } from '@/domain/defaults';

/**
 * Import concurrency: a preview is not an eternal write authorization.
 *
 * Phase 1.3 made the planner judge every reference against `destination + acceptedChanges`, which
 * closed the merge defects — but it computed that projection once, from a destination read before the
 * dialog opened. This application is single-user, not single-tab: another tab can mutate the same
 * IndexedDB database while the import dialog waits for a click. Applying the plan afterwards is a
 * time-of-check / time-of-use gap, and Phase 1.3 wrote such a plan without complaint, orphan and all.
 *
 * Every test here follows the same three-step shape, and deliberately never rebuilds the plan after
 * step two — rebuilding would avoid the defect rather than reproduce it:
 *
 *   A. build a plan that is genuinely valid against the destination as it stands;
 *   B. change the destination through the real repository or import APIs;
 *   C. apply the plan from step A.
 *
 * The required outcome is never "write it anyway" and never "repair it": it is refuse, atomically,
 * with an error that tells the user to take a fresh preview.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-import-concurrency-${String(counter)}`);
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

/** Re-seal an edited envelope so a concurrency test is not stopped by the checksum first. */
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

/** A plan built with the destination truthfully declared, as the dialog does. */
async function planFor(parsed: unknown, mode: 'merge' | 'replace' = 'merge') {
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

/** The whole live state, for the shared relational validator. */
async function liveState() {
  const [{ records }, progressEntries, categories, groups] = await Promise.all([
    listRecords(),
    listProgressEntries(),
    listCategories(),
    listGroups(),
  ]);
  return { records, progressEntries, categories, groups };
}

async function revision(): Promise<number> {
  return (await getMeta())?.dataRevision ?? -1;
}

describe('a stale merge plan cannot orphan a progress entry', () => {
  it('PRIMARY: the target record is purged after the preview, so the note is refused', async () => {
    // A. The destination holds W; the file carries a new note for it. W itself is a conflict.
    const work = await createWorkRecord(workInput({ title: '预览时存在的工作事项' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'incoming-progress-1',
            recordId: work.id,
            occurredOn: ABSENT_DATE,
            note: '来自文件的新进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });

    const plan = await planFor(incoming);
    expect(planBlockers(plan), 'the preview is applicable when it is built').toEqual([]);
    expect(plan.acceptedProgress.map((entry) => entry.id)).toEqual(['incoming-progress-1']);
    expect(plan.accepted.map((record) => record.id)).not.toContain(work.id);

    // B. Another tab purges W. The plan is untouched.
    await softDeleteRecord(work.id);
    await purgeRecord(work.id);
    const before = await revision();

    // C. The user confirms the stale preview.
    await expect(applyImportPlan(plan)).rejects.toThrow(StaleImportPlanError);

    expect(await listProgressEntries(), 'nothing is written').toEqual([]);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
    expect(await revision(), 'a refused import is not a mutation').toBe(before);
  });

  it('the refusal names the cause and tells the user what to do', async () => {
    const work = await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'incoming-progress-2',
            recordId: work.id,
            occurredOn: ABSENT_DATE,
            note: '进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });
    const plan = await planFor(incoming);
    await softDeleteRecord(work.id);
    await purgeRecord(work.id);

    const error = await applyImportPlan(plan).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StaleImportPlanError);
    const message = (error as StaleImportPlanError).message;
    // It must say what happened, that nothing was written, and what to do next...
    expect(message).toContain('本机数据在生成导入预览之后发生了变化');
    expect(message).toContain('未写入任何内容');
    expect(message).toContain('重新选择文件生成预览');
    // ...and must not leak the storage layer's own vocabulary.
    expect(message).not.toMatch(/Dexie|IndexedDB|ConstraintError|BulkError|transaction/i);
    expect((error as StaleImportPlanError).reasons.length).toBeGreaterThan(0);
  });
});

describe('a stale merge plan cannot dangle a taxonomy reference', () => {
  /**
   * The archive references a category it does not itself carry, which the destination supplies.
   *
   * That is the shape where destination drift actually bites. When the file *does* carry the category,
   * a merge re-adds it and the reference resolves — deleting it locally makes the plan no less safe,
   * and refusing would be wrong. An archive whose taxonomy omits a row its records use is exactly
   * what a partial export produces, and Phase 1.3 accepts it for merge on purpose.
   */
  async function envelopeReferencing(
    field: 'categoryId' | 'groupId',
    id: string,
  ): Promise<BackupEnvelope> {
    const template = await createWorkRecord(workInput({ title: '模板' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records.find((record) => record.id === template.id);
    expect(source && isWorkRecord(source)).toBe(true);
    // Remove the template from the destination again: the incoming row must be genuinely new.
    await softDeleteRecord(template.id);
    await purgeRecord(template.id);

    return reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [{ ...source!, id: 'incoming-record', title: '外来记录', [field]: id }],
        // The file carries no taxonomy at all, so it cannot supply the reference itself.
        categories: [],
        groups: [],
      },
      counts: { ...envelope.counts, records: 1, workRecords: 1, categories: 0, groups: 0 },
    });
  }

  it('a category that resolved through the destination is deleted after the preview', async () => {
    const category = await addCategory('本机分类');
    const incoming = await envelopeReferencing('categoryId', category.id);

    const plan = await planFor(incoming);
    expect(planBlockers(plan)).toEqual([]);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);
    expect(plan.referenceRejections).toEqual([]);

    // B. Deleted through the ordinary repository path — it is unused, so this legitimately succeeds.
    expect(await deleteCategoryIfUnused(category.id)).toBe(true);
    const before = await revision();

    await expect(applyImportPlan(plan)).rejects.toThrow(StaleImportPlanError);
    expect((await listRecords()).records).toEqual([]);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
    expect(await revision()).toBe(before);
  });

  it('a group that resolved through the destination is deleted after the preview', async () => {
    const group = await addGroup('本机分组');
    const incoming = await envelopeReferencing('groupId', group.id);

    const plan = await planFor(incoming);
    expect(planBlockers(plan)).toEqual([]);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);

    expect(await deleteGroup(group.id), 'no member, so nothing is detached').toBe(0);
    await expect(applyImportPlan(plan)).rejects.toThrow(StaleImportPlanError);
    expect((await listRecords()).records).toEqual([]);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
  });

  it('a taxonomy row the FILE carries is re-added, so that plan is not stale', async () => {
    /*
     * The other side of the rule, and the reason the check models the local-wins merge semantics
     * rather than simply comparing id sets: a merge whose file supplies the category is still safe
     * after the destination deletes it. Refusing here would be a false positive, and a false positive
     * on a destructive-sounding error is how users learn to ignore it.
     */
    const category = await addCategory('随文件一起到达的分类');
    const template = await createWorkRecord(workInput({ categoryId: category.id }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records.find((record) => record.id === template.id);
    await softDeleteRecord(template.id);
    await purgeRecord(template.id);

    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [{ ...source!, id: 'incoming-record' }],
      },
      counts: { ...envelope.counts, records: 1, workRecords: 1 },
    });
    const plan = await planFor(incoming);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);

    expect(await deleteCategoryIfUnused(category.id)).toBe(true);

    const outcome = await applyImportPlan(plan);
    expect(outcome.recordsWritten).toBe(1);
    expect(outcome.categoriesWritten, 'the file re-supplies the category').toBe(1);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
    const written = (await listRecords()).records.find((record) => record.id === 'incoming-record');
    expect(isWorkRecord(written!) && written.categoryId).toBe(category.id);
  });
});

describe('a stale legacy-replace plan cannot write against taxonomy that is gone', () => {
  it('the retained taxonomy changes between preview and confirmation', async () => {
    /*
     * A legacy file carries no taxonomy: it replaces records and progress and keeps the local
     * categories and groups. So its records must be valid against the taxonomy that exists **at
     * commit time**. The intervening change here is itself an ordinary import — a canonical restore
     * of an archive whose taxonomy omits one built-in category — which is the legitimate way this
     * destination can lose a built-in row, since `deleteCategoryIfUnused` refuses built-ins.
     */
    const legacy = {
      works: [{ id: 'legacy_1', title: '旧版记录', date: '2026-01-01', biz: '会议·活动' }],
    };
    const plan = await planFor(legacy, 'replace');
    expect(plan.strategy).toBe('legacy-replace');
    const accepted = plan.accepted[0];
    expect(isWorkRecord(accepted!) && accepted.categoryId).toBe(
      BUILT_IN_CATEGORY_IDS.meetingsAndEvents,
    );
    expect(planBlockers(plan)).toEqual([]);

    // B. Another tab restores a canonical archive whose taxonomy lacks that category.
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const trimmed = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [],
        progressEntries: [],
        categories: envelope.payload.categories.filter(
          (category) => category.id !== BUILT_IN_CATEGORY_IDS.meetingsAndEvents,
        ),
      },
      counts: {
        ...envelope.counts,
        records: 0,
        workRecords: 0,
        honorRecords: 0,
        progressEntries: 0,
        categories: envelope.payload.categories.length - 1,
      },
    });
    const restore = await planFor(trimmed, 'replace');
    expect(restore.strategy).toBe('canonical-restore');
    await applyImportPlan(restore);
    expect(
      (await listCategories()).some((c) => c.id === BUILT_IN_CATEGORY_IDS.meetingsAndEvents),
    ).toBe(false);
    const before = await revision();

    // C. The stale legacy plan must not write a record whose category no longer exists.
    await expect(applyImportPlan(plan)).rejects.toThrow(StaleImportPlanError);
    expect((await listRecords()).records).toEqual([]);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
    expect(await revision()).toBe(before);
  });
});

describe('a stale plan cannot overwrite a destination entity', () => {
  it('an accepted record id appears in the destination after the preview', async () => {
    /*
     * Applying the very same confirmed plan twice is the honest way to produce this: the first apply
     * is what adds the id, so the second is a genuine stale plan with no test-only poking at the
     * store. Phase 1.3 reached `bulkAdd` and surfaced a raw `ConstraintError`.
     */
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records[0];
    const incoming = await reseal({
      ...envelope,
      payload: { ...envelope.payload, records: [{ ...source!, id: 'incoming-record' }] },
      counts: { ...envelope.counts, records: 1, workRecords: 1, honorRecords: 0 },
    });

    const plan = await planFor(incoming);
    expect(plan.accepted.map((record) => record.id)).toEqual(['incoming-record']);
    const first = await applyImportPlan(plan);
    expect(first.recordsWritten).toBe(1);

    const snapshotBefore = (await listRecords()).records;
    const before = await revision();
    await expect(applyImportPlan(plan), 'the same plan is now stale').rejects.toThrow(
      StaleImportPlanError,
    );
    expect((await listRecords()).records, 'no row is replaced or duplicated').toEqual(
      snapshotBefore,
    );
    expect(await revision()).toBe(before);
  });

  it('an accepted progress id appears in the destination after the preview', async () => {
    const work = await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'incoming-progress-3',
            recordId: work.id,
            occurredOn: ABSENT_DATE,
            note: '来自文件的进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });

    const plan = await planFor(incoming);
    expect(plan.acceptedProgress.map((entry) => entry.id)).toEqual(['incoming-progress-3']);
    await applyImportPlan(plan);
    const notesBefore = await listProgressEntries();
    expect(notesBefore).toHaveLength(1);

    await expect(applyImportPlan(plan)).rejects.toThrow(StaleImportPlanError);
    expect(await listProgressEntries(), 'the stored note is untouched').toEqual(notesBefore);
  });
});

describe('a refused import leaves every store exactly as it was', () => {
  it('records, progress, taxonomy, settings and meta all roll back together', async () => {
    /*
     * The stale plan here would have written a record, a note, a new category and a new group, and
     * bumped the revision. A partial write is the worst possible outcome — worse than either applying
     * or refusing — so every store the transaction touches is compared before and after.
     */
    const work = await createWorkRecord(workInput({ title: '将被彻底删除' }));
    await addProgressEntry({ recordId: work.id, note: '本机进展' });
    await saveSettings({ ...(await getSettings()), appTitle: '本机标题' });

    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records.find((record) => record.id === work.id);
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [{ ...source!, id: 'incoming-record', title: '外来记录' }],
        progressEntries: [
          {
            id: 'incoming-progress-4',
            recordId: work.id,
            occurredOn: ABSENT_DATE,
            note: '外来进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
        // Built by cloning a real seeded row, so the file stays schema-valid whatever fields the
        // taxonomy carries — a hand-written literal here would fail parsing, not the check under test.
        categories: [
          ...envelope.payload.categories,
          {
            ...envelope.payload.categories[0]!,
            id: 'file-only-category',
            name: '文件独有分类',
            builtIn: false,
          },
        ],
        groups: [
          ...envelope.payload.groups,
          {
            ...envelope.payload.groups[0]!,
            id: 'file-only-group',
            name: '文件独有分组',
            builtIn: false,
          },
        ],
      },
      counts: {
        ...envelope.counts,
        records: 1,
        workRecords: 1,
        progressEntries: 1,
        categories: envelope.payload.categories.length + 1,
        groups: envelope.payload.groups.length + 1,
      },
    });

    const plan = await planFor(incoming);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.acceptedProgress).toHaveLength(1);

    // B. The note's target is purged, which is what makes the plan stale.
    await softDeleteRecord(work.id);
    await purgeRecord(work.id);

    const snapshot = {
      records: (await listRecords()).records,
      progress: await listProgressEntries(),
      categories: await listCategories(),
      groups: await listGroups(),
      settings: await getSettings(),
      revision: await revision(),
    };

    await expect(applyImportPlan(plan)).rejects.toThrow(StaleImportPlanError);

    expect((await listRecords()).records).toEqual(snapshot.records);
    expect(await listProgressEntries()).toEqual(snapshot.progress);
    expect(await listCategories(), 'the file-only category is not added').toEqual(
      snapshot.categories,
    );
    expect(await listGroups(), 'the file-only group is not added').toEqual(snapshot.groups);
    expect(await getSettings()).toEqual(snapshot.settings);
    expect(await revision(), 'dataRevision is untouched').toBe(snapshot.revision);
  });
});

describe('the honest remedy still works', () => {
  it('rebuilding the plan against the new destination gives the correct new preview', async () => {
    const work = await createWorkRecord(workInput({ title: '预览时存在的工作事项' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'incoming-progress-5',
            recordId: work.id,
            occurredOn: ABSENT_DATE,
            note: '来自文件的新进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });

    const stale = await planFor(incoming);
    await softDeleteRecord(work.id);
    await purgeRecord(work.id);
    await expect(applyImportPlan(stale)).rejects.toThrow(StaleImportPlanError);

    /*
     * The remedy the error asks for. The record is no longer a conflict, so a fresh preview accepts
     * it — and the note, whose target now arrives in the same file, is accepted with it. The user gets
     * a different and correct import rather than a blocked one.
     */
    const rebuilt = await planFor(incoming);
    expect(rebuilt.accepted.map((record) => record.id)).toEqual([work.id]);
    expect(rebuilt.acceptedProgress.map((entry) => entry.id)).toEqual(['incoming-progress-5']);
    expect(rebuilt.orphanProgress).toEqual([]);
    expect(planBlockers(rebuilt)).toEqual([]);

    const outcome = await applyImportPlan(rebuilt);
    expect(outcome.recordsWritten).toBe(1);
    expect(outcome.progressWritten).toBe(1);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
  });

  it('an ordinary merge into an unchanged destination still succeeds', async () => {
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records[0];
    const incoming = await reseal({
      ...envelope,
      payload: { ...envelope.payload, records: [{ ...source!, id: 'incoming-record' }] },
      counts: { ...envelope.counts, records: 1, workRecords: 1 },
    });

    const plan = await planFor(incoming);
    const before = await revision();
    const outcome = await applyImportPlan(plan);

    expect(outcome.recordsWritten).toBe(1);
    expect((await listRecords()).records).toHaveLength(2);
    expect(await revision()).toBe(before + 1);
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);
  });

  it('a canonical exact restore succeeds even though the destination changed after the preview', async () => {
    /*
     * `restore(D, B(S)) = S` for an arbitrary destination `D`. A restore replaces records, progress,
     * categories, groups and settings wholesale, so destination drift is irrelevant by construction —
     * and over-constraining it would be a regression, not extra safety. Every kind of drift the other
     * tests treat as fatal happens here, and the restore still lands exactly.
     */
    const kept = await createWorkRecord(workInput({ title: '备份中的记录' }));
    await addProgressEntry({ recordId: kept.id, note: '备份中的进展' });
    const category = await addCategory('备份中的分类');
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const plan = await planFor(envelope, 'replace');
    expect(plan.strategy).toBe('canonical-restore');
    expect(plan.exactRestorePossible).toBe(true);

    // B. Drift of every kind: a record purged, a note added, taxonomy deleted, settings edited.
    const doomed = await createWorkRecord(workInput({ title: '预览后新增又删除' }));
    await addProgressEntry({ recordId: kept.id, note: '预览后新增的进展' });
    await softDeleteRecord(doomed.id);
    await purgeRecord(doomed.id);
    await saveSettings({ ...(await getSettings()), appTitle: '预览后改过的标题' });
    const strayGroup = await addGroup('预览后新增的分组');
    expect(await deleteCategoryIfUnused(category.id)).toBe(true);

    // C. The restore is unaffected and exact.
    const outcome = await applyImportPlan(plan);
    expect(outcome.taxonomyReplaced).toBe(true);

    const after = await liveState();
    expect(after.records.map((record) => record.id)).toEqual([kept.id]);
    expect(after.progressEntries.map((entry) => entry.note)).toEqual(['备份中的进展']);
    expect(after.categories.map((c) => c.id).sort()).toEqual(
      envelope.payload.categories.map((c) => c.id).sort(),
    );
    expect(
      after.categories.some((c) => c.id === category.id),
      'the archive restores it',
    ).toBe(true);
    expect(
      after.groups.some((g) => g.id === strayGroup.id),
      'the stray group is gone',
    ).toBe(false);
    expect((await getSettings()).appTitle).toBe(envelope.payload.settings.appTitle);
    expect(validateRelationalIntegrity(after)).toEqual([]);
  });

  it('a committed merge and legacy replace both leave a state the shared validator accepts', async () => {
    // Merge first.
    const local = await createWorkRecord(workInput({ title: '本机记录' }));
    await addProgressEntry({ recordId: local.id, note: '本机进展' });
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records.find((record) => record.id === local.id);
    const merged = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        records: [{ ...source!, id: 'incoming-record' }],
        progressEntries: [
          {
            id: 'incoming-progress-6',
            recordId: 'incoming-record',
            occurredOn: ABSENT_DATE,
            note: '外来进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, records: 1, workRecords: 1, progressEntries: 1 },
    });
    await applyImportPlan(await planFor(merged));
    expect(validateRelationalIntegrity(await liveState())).toEqual([]);

    // Then a legacy replace over the merged state.
    const legacy = {
      works: [{ id: 'legacy_1', title: '旧版记录', date: '2026-01-01', biz: '文稿·材料' }],
    };
    await applyImportPlan(await planFor(legacy, 'replace'));
    const after = await liveState();
    expect(after.records.map((record) => record.id)).toEqual(['legacy_1']);
    expect(validateRelationalIntegrity(after)).toEqual([]);
  });
});

describe('the check and the write share one transaction', () => {
  it('the preflight reads inside the write transaction, and only one is opened', async () => {
    /*
     * The property the whole patch rests on, asserted rather than asserted *about*. Revalidating in
     * transaction 1 and writing in transaction 2 would look identical in every other test here and
     * would reproduce the same defect over a shorter interval, so this test watches the mechanism:
     * how many transactions `applyImportPlan` opens, whether the preflight's read happens inside one,
     * and whether that transaction's scope covers every store the decision and the write depend on.
     */
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records[0];
    const incoming = await reseal({
      ...envelope,
      payload: { ...envelope.payload, records: [{ ...source!, id: 'incoming-record' }] },
      counts: { ...envelope.counts, records: 1, workRecords: 1 },
    });
    const plan = await planFor(incoming);

    let transactions = 0;
    const openTransaction = db.transaction.bind(db);
    db.transaction = ((...args: Parameters<typeof db.transaction>) => {
      transactions += 1;
      return openTransaction(...args);
    }) as typeof db.transaction;

    let scopeAtPreflightRead: string[] | null = null;
    let observed = false;
    const readRecords = db.records.toArray.bind(db.records);
    db.records.toArray = () => {
      if (!observed) {
        observed = true;
        /*
         * `Dexie.currentTransaction` is typed as always present but is null outside a transaction, so
         * the runtime value is the evidence here and the type is not. Read through `unknown` to say
         * that deliberately rather than trusting the declaration.
         */
        const active: unknown = Dexie.currentTransaction;
        scopeAtPreflightRead = active ? [...(active as Transaction).storeNames].sort() : null;
      }
      return readRecords();
    };

    try {
      await applyImportPlan(plan);
    } finally {
      db.transaction = openTransaction;
      db.records.toArray = readRecords;
    }

    expect(transactions, 'exactly one transaction, so no gap between check and write').toBe(1);
    expect(scopeAtPreflightRead, 'the preflight read was inside a transaction').not.toBeNull();
    expect(scopeAtPreflightRead, 'its scope covers every store the import reads or writes').toEqual(
      ['categories', 'groups', 'meta', 'progressEntries', 'records', 'settings'],
    );
  });
});

describe('a destination that is already corrupt is not a place to add more data', () => {
  it('a merge is refused, and says the local data is the problem', async () => {
    /*
     * Not a stale preview: the destination was damaged independently — here by writing an orphan note
     * straight into the store, which is what a corrupted database looks like from the importer's side.
     * Stacking an import on top would make the projected state invalid while presenting the file as
     * the cause. Repair stays where it belongs, in Diagnostics.
     */
    await createWorkRecord(workInput({ title: '本机记录' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const source = envelope.payload.records[0];
    const incoming = await reseal({
      ...envelope,
      payload: { ...envelope.payload, records: [{ ...source!, id: 'incoming-record' }] },
      counts: { ...envelope.counts, records: 1, workRecords: 1 },
    });
    const plan = await planFor(incoming);

    await db.progressEntries.add({
      id: 'orphan-note',
      recordId: 'no-such-record',
      occurredOn: ABSENT_DATE,
      note: '损坏数据',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });

    const error = await applyImportPlan(plan).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StaleImportPlanError);
    expect((error as StaleImportPlanError).reasons.join('')).toContain(
      '本机数据当前本身存在关联关系问题',
    );
    expect((error as StaleImportPlanError).reasons.join('')).toContain('设置 → 诊断');
    expect(
      (await listRecords()).records.some((record) => record.id === 'incoming-record'),
      'nothing is added on top of a broken store',
    ).toBe(false);
  });
});
