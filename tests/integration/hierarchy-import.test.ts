import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import { listProgressEntries, listRecords } from '@/db/repositories/records';
import { moveWorkRecord } from '@/db/repositories/work-hierarchy';
import { listCategories, listGroups } from '@/db/repositories/taxonomy';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { defaultCategories, defaultGroups, defaultSettings } from '@/domain/defaults';
import { validateRelationalIntegrity } from '@/domain/integrity';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord, WorkRecord } from '@/domain/types';
import { buildEnvelope } from '@/services/backup/envelope';
import { ImportBlockedError, applyImportPlan } from '@/services/import/apply';
import { buildImportPlan, planBlockers } from '@/services/import/plan';
import type { ImportMode } from '@/services/import/plan';
import { StaleImportPlanError } from '@/services/import/preflight';
import { makeWork } from '../fixtures/records';

/**
 * Importing into a hierarchy (docs/phase-5-product-evolution.md §7 and §10.2).
 *
 * Two halves:
 *   - a legacy file's flat `subtasks[]` becomes level-2 work records, deterministically, without
 *     inventing values and without silently dropping anything it cannot map;
 *   - a merge or a legacy replace is judged on its **projected final tree**, and refused whole when that
 *     tree would dangle, cycle or run past three levels — including when it only goes wrong at commit
 *     time because another tab changed the destination.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-hierarchy-import-${String(counter)}`);
  await db.open();
  await ensureSeedData(db);
  setDatabase(db);
});

afterEach(async () => {
  setDatabase(null);
  await db.delete();
});

async function planFor(parsed: unknown, mode: ImportMode) {
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

async function storedRecords(): Promise<AnyRecord[]> {
  return (await listRecords()).records;
}

async function expectValidStore(): Promise<void> {
  const [records, progress, categories, groups] = await Promise.all([
    storedRecords(),
    listProgressEntries(),
    listCategories(),
    listGroups(),
  ]);
  expect(
    validateRelationalIntegrity({ records, progressEntries: progress, categories, groups }),
  ).toEqual([]);
}

/** A legacy `{version, exportTime, works}` file whose row carries a flat `subtasks[]`. Synthetic. */
function legacyFileWithSubtasks(): unknown {
  return {
    version: 2,
    exportTime: '2026-09-01 10:00:00',
    works: [
      {
        id: 'legacy-parent',
        title: '筹备示范年度会议',
        date: '2026-09-01',
        done: '进行中',
        subtasks: [
          {
            title: '起草会议方案',
            deadline: '2026-09-10',
            done: true,
            doneTime: '2026-09-09',
            remark: '已送审',
          },
          { id: 's-2', text: '联系示范会场', done: false, due: '2026-09-20', extra: { floor: 3 } },
          { done: true },
          'not-an-object',
          { name: '准备签到表', status: '推迟' },
        ],
      },
    ],
  };
}

describe('legacy flat subtasks become level-2 work records', () => {
  it('maps what the element states, invents nothing, and warns about the rest', async () => {
    const plan = await planFor(legacyFileWithSubtasks(), 'replace');
    expect(planBlockers(plan)).toEqual([]);
    expect(plan.hierarchyIssues).toEqual([]);

    const work = plan.accepted.filter(isWorkRecord);
    const byId = new Map(work.map((record) => [record.id, record]));
    expect([...byId.keys()].sort()).toEqual([
      'legacy-parent',
      'legacy-parent::sub-1',
      'legacy-parent::sub-5',
      'legacy-parent::sub-s-2',
    ]);
    expect(plan.summary.acceptedSubtasks).toBe(3);

    const first = byId.get('legacy-parent::sub-1');
    expect(first).toMatchObject({
      parentWorkId: 'legacy-parent',
      title: '起草会议方案',
      status: 'completed',
      reportDeadline: { kind: 'plain', date: '2026-09-10' },
      completedOn: { kind: 'plain', date: '2026-09-09' },
      remark: '已送审',
      // Not stated by the element, so not copied from the parent.
      categoryId: null,
      groupId: null,
      counterpartUnit: '',
      occurredOn: { kind: 'absent' },
    });

    const second = byId.get('legacy-parent::sub-s-2');
    expect(second).toMatchObject({
      status: 'todo',
      completionDeadline: { kind: 'plain', date: '2026-09-20' },
      legacyResidue: { extra: '{"floor":3}' },
    });

    const fifth = byId.get('legacy-parent::sub-5');
    expect(fifth).toMatchObject({ title: '准备签到表', status: 'deferred', statusLabel: '推迟' });

    const fields = plan.warnings.map((warning) => `${warning.field}: ${warning.message}`);
    expect(fields.some((line) => line.startsWith('subtasks[3]') && line.includes('no title'))).toBe(
      true,
    );
    expect(
      fields.some((line) => line.startsWith('subtasks[4]') && line.includes('not an object')),
    ).toBe(true);
    expect(fields.some((line) => line.includes('extra'))).toBe(true);

    await applyImportPlan(plan);
    const stored = (await storedRecords()).filter(isWorkRecord);
    expect(stored.filter((record) => record.parentWorkId === 'legacy-parent')).toHaveLength(3);
    await expectValidStore();
  });

  it('importing the same file again yields conflicts, not a second set of sub-tasks', async () => {
    await applyImportPlan(await planFor(legacyFileWithSubtasks(), 'replace'));
    const again = await planFor(legacyFileWithSubtasks(), 'merge');
    expect(again.accepted).toEqual([]);
    expect(again.conflicts.map((conflict) => conflict.id).sort()).toEqual([
      'legacy-parent',
      'legacy-parent::sub-1',
      'legacy-parent::sub-5',
      'legacy-parent::sub-s-2',
    ]);
    expect((await storedRecords()).filter(isWorkRecord)).toHaveLength(4);
  });

  it('does not attach sub-tasks to a different record that merely shares the parent id', async () => {
    await db.records.add(makeWork({ id: 'legacy-parent', title: '本机另一条记录' }));
    const plan = await planFor(legacyFileWithSubtasks(), 'merge');
    expect(plan.accepted.filter(isWorkRecord)).toEqual([]);
    const reasons = plan.rejected.map((rejection) => rejection.reason);
    expect(reasons.filter((reason) => reason.includes('内容不同'))).toHaveLength(3);
  });

  it('keeps an honour row’s subtasks in its residue, with a warning', async () => {
    const plan = await planFor(
      [
        {
          id: 'h1',
          category: '荣誉',
          title: '示范表彰',
          date: '2026-06-01',
          subtasks: [{ title: '不可能的子任务' }],
        },
      ],
      'replace',
    );
    const honor = plan.accepted[0];
    expect(honor?.kind).toBe('honor');
    expect(honor?.legacyResidue?.['subtasks']).toBe('[{"title":"不可能的子任务"}]');
    expect(plan.warnings.some((warning) => warning.field === 'subtasks')).toBe(true);
  });

  it('keeps a non-array subtasks value and any other structured unknown field, never dropping it', async () => {
    const plan = await planFor(
      [{ id: 'w1', title: '示范任务', subtasks: '见附件', tags: ['甲', '乙'], empty: [] }],
      'replace',
    );
    const record = plan.accepted[0];
    expect(record?.legacyResidue).toEqual({ subtasks: '见附件', tags: '["甲","乙"]' });
    expect(plan.accepted.filter(isWorkRecord)).toHaveLength(1);
  });
});

describe('a merge is judged on its projected final tree', () => {
  function envelopeOf(records: readonly AnyRecord[]) {
    return buildEnvelope(
      {
        records,
        progressEntries: [],
        categories: defaultCategories(),
        groups: defaultGroups(),
        settings: defaultSettings(),
      },
      '2026-09-29T00:00:00.000Z',
    );
  }

  it('accepts incoming children of a destination task', async () => {
    await db.records.add(makeWork({ id: 'dest-root' }));
    const plan = await planFor(
      await envelopeOf([
        makeWork({ id: 'in-child', parentWorkId: 'dest-root' }),
        makeWork({ id: 'in-grandchild', parentWorkId: 'in-child' }),
      ]),
      'merge',
    );
    expect(planBlockers(plan)).toEqual([]);
    await applyImportPlan(plan);
    await expectValidStore();
  });

  it('refuses the whole merge when incoming records form a cycle together', async () => {
    const plan = await planFor(
      await envelopeOf([
        makeWork({ id: 'y', parentWorkId: 'z' }),
        makeWork({ id: 'z', parentWorkId: 'y' }),
        makeWork({ id: 'innocent' }),
      ]),
      'merge',
    );
    expect(plan.hierarchyIssues.map((issue) => issue.kind)).toContain('work-hierarchy-cycle');
    expect(planBlockers(plan).join(' ')).toContain('任务层级将不自洽');
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);
    // Not even the innocent record was written.
    expect(await storedRecords()).toEqual([]);
  });

  it('refuses a merge that would put an incoming record at level 4 under the destination', async () => {
    await db.records.bulkAdd([
      makeWork({ id: 'l1' }),
      makeWork({ id: 'l2', parentWorkId: 'l1' }),
      makeWork({ id: 'l3', parentWorkId: 'l2' }),
    ]);
    const plan = await planFor(
      await envelopeOf([makeWork({ id: 'l4', parentWorkId: 'l3' })]),
      'merge',
    );
    expect(plan.hierarchyIssues.map((issue) => issue.kind)).toEqual(['work-hierarchy-too-deep']);
    expect(planBlockers(plan)).not.toEqual([]);
  });

  it('refuses a merge whose child would dangle because its parent was declined', async () => {
    const plan = await planFor(
      await envelopeOf([
        makeWork({ id: 'declined-parent', categoryId: 'category-nobody-has' }),
        makeWork({ id: 'child', parentWorkId: 'declined-parent' }),
      ]),
      'merge',
    );
    expect(plan.referenceRejections.map((rejection) => rejection.id)).toEqual(['declined-parent']);
    expect(plan.hierarchyIssues).toEqual([
      { kind: 'dangling-parent-work', id: 'child', reference: 'declined-parent' },
    ]);
    expect(planBlockers(plan)).not.toEqual([]);
  });

  it('refuses at commit time when another tab deepened the destination after the preview', async () => {
    await db.records.bulkAdd([makeWork({ id: 'p' }), makeWork({ id: 'q' })]);
    const plan = await planFor(
      await envelopeOf([
        makeWork({ id: 'c1', parentWorkId: 'p' }),
        makeWork({ id: 'c2', parentWorkId: 'c1' }),
      ]),
      'merge',
    );
    expect(planBlockers(plan)).toEqual([]);

    // Meanwhile: p moves under q, so c2 would now land at level 4.
    await moveWorkRecord('p', 'q');
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(StaleImportPlanError);
    const ids = (await storedRecords()).map((record) => record.id).sort();
    expect(ids).toEqual(['p', 'q']);
  });

  it('names a destination that was already damaged instead of blaming the file', async () => {
    await db.records.add(makeWork({ id: 'broken', parentWorkId: 'purged-parent' }));
    const plan = await planFor(await envelopeOf([makeWork({ id: 'fine' })]), 'merge');
    expect(plan.destinationHierarchyDamaged).toBe(true);
    expect(planBlockers(plan).join(' ')).toContain('本机的任务层级当前本身已不自洽');
  });
});

describe('a legacy replace is judged on its own projected tree', () => {
  it('rejects the sub-tasks of a row that could not be imported, and writes a valid tree', async () => {
    const file = legacyFileWithSubtasks() as { works: Record<string, unknown>[] };
    const parent = file.works[0];
    if (!parent) throw new Error('no row');
    // A duplicate of the parent row: the second copy is declined, and so are its sub-tasks.
    file.works.push({ ...parent });
    const plan = await planFor(file, 'replace');
    const declined = plan.rejected.filter((rejection) =>
      rejection.reason.includes('子任务一并未导入'),
    );
    expect(declined.length).toBeGreaterThan(0);
    expect(plan.hierarchyIssues).toEqual([]);
    await applyImportPlan(plan);
    await expectValidStore();
    const children = (await storedRecords())
      .filter(isWorkRecord)
      .filter((record: WorkRecord) => record.parentWorkId === 'legacy-parent');
    expect(children).toHaveLength(3);
  });
});
