import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  purgeAllDeleted,
  purgeRecord,
  restoreRecord,
  softDeleteRecord,
  updateRecord,
} from '@/db/repositories/records';
import type { WorkRecordPatch } from '@/db/repositories/records';
import {
  moveWorkRecord,
  purgeSubtree,
  restoreSubtree,
  sameBatchDescendants,
  softDeletePromotingChildren,
  softDeleteSubtree,
} from '@/db/repositories/work-hierarchy';
import { META_KEY } from '@/db/schema';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ABSENT_DATE } from '@/domain/dates';
import { HierarchyError } from '@/domain/hierarchy';
import { validateRelationalIntegrity } from '@/domain/integrity';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord, WorkRecord } from '@/domain/types';
import { setClock } from '@/utils/clock';
import { makeWork } from '../fixtures/records';

/**
 * The hierarchy at the write boundary.
 *
 * Every rule in `@/domain/hierarchy` is enforced here inside the transaction that writes, and every
 * operation must leave a state the relational validator accepts. The concurrency section drives the
 * conflicting pairs from docs/phase-5-product-evolution.md §4.5 at the same time, in both orders.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-hierarchy-${String(counter)}`);
  await db.open();
  await ensureSeedData(db);
  setDatabase(db);
});

afterEach(async () => {
  setDatabase(null);
  await db.delete();
});

function input(title: string) {
  return {
    title,
    occurredOn: ABSENT_DATE,
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
  };
}

async function create(title: string, parentWorkId: string | null = null): Promise<WorkRecord> {
  return createWorkRecord(input(title), { parentWorkId });
}

/** Level 1 → 2 → 3, plus a sibling at level 2. */
async function threeLevels(): Promise<{
  l1: WorkRecord;
  l2: WorkRecord;
  l3: WorkRecord;
  l2b: WorkRecord;
}> {
  const l1 = await create('一级任务');
  const l2 = await create('二级子任务', l1.id);
  const l3 = await create('三级子任务', l2.id);
  const l2b = await create('另一个二级子任务', l1.id);
  return { l1, l2, l3, l2b };
}

async function records(): Promise<AnyRecord[]> {
  return (await listRecords()).records;
}

async function work(id: string): Promise<WorkRecord> {
  const found = (await records()).find((record) => record.id === id);
  if (found?.kind !== 'work') throw new Error(`no work record ${id}`);
  return found;
}

async function expectValid(): Promise<void> {
  const [all, progress, categories, groups] = await Promise.all([
    records(),
    listProgressEntries(),
    db.categories.toArray(),
    db.groups.toArray(),
  ]);
  expect(
    validateRelationalIntegrity({ records: all, progressEntries: progress, categories, groups }),
  ).toEqual([]);
}

async function revision(): Promise<number> {
  return (await db.meta.get(META_KEY))?.value.dataRevision ?? -1;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (cause) {
    let current: unknown = cause;
    while (current instanceof Error) {
      if (current instanceof HierarchyError) return current.reason;
      current = current.cause;
    }
    throw cause;
  }
  throw new Error('expected a refusal');
}

describe('creating levels', () => {
  it('creates a level-1 task, a level-2 child and a level-3 grandchild', async () => {
    const { l1, l2, l3 } = await threeLevels();
    expect(l1.parentWorkId).toBeNull();
    expect((await work(l2.id)).parentWorkId).toBe(l1.id);
    expect((await work(l3.id)).parentWorkId).toBe(l2.id);
    await expectValid();
  });

  it('refuses a fourth level, and writes nothing', async () => {
    const { l3 } = await threeLevels();
    const before = await revision();
    expect(await refusal(create('第四级', l3.id))).toBe('too-deep');
    expect(await revision()).toBe(before);
    expect((await records()).filter(isWorkRecord)).toHaveLength(4);
  });

  it('refuses a missing parent, an honour parent and a trashed parent', async () => {
    const honor = await createHonorRecord({
      title: '示范荣誉',
      awardedOn: ABSENT_DATE,
      honorType: '',
      level: '',
      issuingOrg: '',
      documentNo: '',
      personalRole: '',
      evidenceLocation: '',
      relatedWorkId: null,
      remark: '',
    });
    const trashed = await create('回收站里的任务');
    await softDeleteRecord(trashed.id);
    expect(await refusal(create('孤儿', 'no-such-record'))).toBe('parent-missing');
    expect(await refusal(create('挂在荣誉下', honor.id))).toBe('parent-not-work');
    expect(await refusal(create('挂在回收站下', trashed.id))).toBe('parent-deleted');
    await expectValid();
  });

  it('an ordinary edit cannot move a record in the tree', async () => {
    const { l2 } = await threeLevels();
    const sneaky = { title: '改名', parentWorkId: null } as unknown as WorkRecordPatch;
    await expect(updateRecord(l2.id, sneaky)).rejects.toThrow('parentWorkId');
  });
});

describe('re-parenting', () => {
  it('moves a record with its subtree, and to the top level', async () => {
    const { l1, l2, l3, l2b } = await threeLevels();
    await moveWorkRecord(l2b.id, l2.id);
    expect((await work(l2b.id)).parentWorkId).toBe(l2.id);
    await moveWorkRecord(l2.id, null);
    expect((await work(l2.id)).parentWorkId).toBeNull();
    // The subtree came along.
    expect((await work(l3.id)).parentWorkId).toBe(l2.id);
    expect((await work(l1.id)).parentWorkId).toBeNull();
    await expectValid();
  });

  it('refuses self, a descendant, a fourth level and a non-work parent, and writes nothing', async () => {
    const { l1, l2, l3, l2b } = await threeLevels();
    const before = await revision();
    expect(await refusal(moveWorkRecord(l1.id, l1.id))).toBe('parent-is-self');
    expect(await refusal(moveWorkRecord(l1.id, l3.id))).toBe('parent-is-descendant');
    // l2 carries l3, so under l2b it would put l3 at level 4.
    expect(await refusal(moveWorkRecord(l2.id, l2b.id))).toBe('too-deep');
    expect(await refusal(moveWorkRecord(l2.id, 'no-such-record'))).toBe('parent-missing');
    expect(await revision()).toBe(before);
    await expectValid();
  });
});

describe('trash, restore and purge', () => {
  it('never trashes a record with live sub-tasks on its own', async () => {
    const { l1, l3 } = await threeLevels();
    expect(await refusal(softDeleteRecord(l1.id))).toBe('has-live-descendants');
    // A leaf goes normally.
    await softDeleteRecord(l3.id);
    expect((await work(l3.id)).deletedAt).not.toBeNull();
  });

  it('trashes a whole subtree under one stamp, and restores exactly that batch', async () => {
    const { l1, l2, l3, l2b } = await threeLevels();
    /*
     * l2b is trashed on its own first, at an earlier instant, so it is not part of the later batch.
     * The test clock is pinned, so the earlier instant is set explicitly — a batch is identified by its
     * shared stamp, and two separate operations get two different stamps from a real clock.
     */
    const restoreClock = setClock({ now: () => '2026-09-21T08:00:00.000Z', id: () => 'unused' });
    await softDeleteRecord(l2b.id);
    restoreClock();
    const before = await revision();
    const outcome = await softDeleteSubtree(l1.id);
    expect(outcome.affected).toBe(3);
    expect(await revision()).toBe(before + 1);
    const stamps = new Set([
      (await work(l1.id)).deletedAt,
      (await work(l2.id)).deletedAt,
      (await work(l3.id)).deletedAt,
    ]);
    expect(stamps.size).toBe(1);
    expect(
      sameBatchDescendants(await records(), l1.id)
        .map((record) => record.id)
        .sort(),
    ).toEqual([l2.id, l3.id].sort());

    const restored = await restoreSubtree(l1.id);
    expect(restored.affected).toBe(3);
    expect((await work(l3.id)).deletedAt).toBeNull();
    // The earlier, separate deletion is not undone.
    expect((await work(l2b.id)).deletedAt).not.toBeNull();
    await expectValid();
  });

  it('refuses to restore a sub-task while its parent is in the trash', async () => {
    const { l1, l2 } = await threeLevels();
    await softDeleteSubtree(l1.id);
    expect(await refusal(restoreRecord(l2.id))).toBe('parent-in-trash');
    expect(await refusal(restoreSubtree(l2.id))).toBe('parent-in-trash');
    await restoreRecord(l1.id);
    await restoreRecord(l2.id);
    expect((await work(l2.id)).deletedAt).toBeNull();
  });

  it('promotes live children one level, then trashes the record', async () => {
    const { l1, l2, l3 } = await threeLevels();
    const outcome = await softDeletePromotingChildren(l2.id);
    expect(outcome.affected).toBe(2);
    expect((await work(l2.id)).deletedAt).not.toBeNull();
    expect((await work(l3.id)).parentWorkId).toBe(l1.id);
    expect((await work(l3.id)).deletedAt).toBeNull();
    await expectValid();
  });

  it('never purges a record something still names as parent', async () => {
    const { l2 } = await threeLevels();
    expect(await refusal(purgeRecord(l2.id))).toBe('has-descendants');
  });

  it('purges a trashed subtree with its progress and detaches linked honours', async () => {
    const { l1, l3 } = await threeLevels();
    await addProgressEntry({ recordId: l3.id, note: '三级任务的进展' });
    await createHonorRecord({
      title: '关联三级任务的荣誉',
      awardedOn: ABSENT_DATE,
      honorType: '',
      level: '',
      issuingOrg: '',
      documentNo: '',
      personalRole: '',
      evidenceLocation: '',
      relatedWorkId: l3.id,
      remark: '',
    });
    expect(await refusal(purgeSubtree(l1.id))).toBe('not-in-trash');
    await softDeleteSubtree(l1.id);
    const outcome = await purgeSubtree(l1.id);
    expect(outcome).toEqual({ recordsPurged: 4, progressPurged: 1, honorsDetached: 1 });
    const left = await records();
    expect(left.filter(isWorkRecord)).toHaveLength(0);
    expect(left.find((record) => record.kind === 'honor')).toMatchObject({ relatedWorkId: null });
    await expectValid();
  });

  it('refuses to purge a subtree that still has a live member', async () => {
    const { l1, l2 } = await threeLevels();
    // Only possible from an imported archive: a trashed root above a live child.
    await db.records.update(l1.id, { deletedAt: '2026-09-01T00:00:00.000Z' });
    expect((await work(l2.id)).deletedAt).toBeNull();
    expect(await refusal(purgeSubtree(l1.id))).toBe('has-live-descendants');
    expect(await refusal(purgeAllDeleted())).toBe('has-live-descendants');
  });

  it('purges a batch-trashed chain leaf first, refusing every record still named as parent', async () => {
    const root = await create('根任务');
    const child = await create('子任务', root.id);
    const grandchild = await create('孙任务', child.id);
    await softDeleteSubtree(root.id);

    expect(await refusal(purgeRecord(root.id))).toBe('has-descendants');
    expect(await refusal(purgeRecord(child.id))).toBe('has-descendants');
    // Each refusal changed nothing.
    expect((await records()).filter(isWorkRecord)).toHaveLength(3);

    for (const record of [grandchild, child, root]) {
      await purgeRecord(record.id);
      await expectValid();
    }
    expect((await records()).filter(isWorkRecord)).toHaveLength(0);
  });

  it('purges a trashed middle subtree while its parent stays in the trash', async () => {
    const root = await create('根任务');
    const child = await create('子任务', root.id);
    await create('孙任务', child.id);
    await softDeleteSubtree(root.id);

    const outcome = await purgeSubtree(child.id);
    expect(outcome.recordsPurged).toBe(2);
    const left = (await records()).filter(isWorkRecord);
    expect(left.map((record) => record.id)).toEqual([root.id]);
    expect(left[0]?.deletedAt).not.toBeNull();
    await expectValid();
    // Nothing names the root any more, so it goes on its own.
    await purgeRecord(root.id);
    expect((await records()).filter(isWorkRecord)).toHaveLength(0);
  });

  it('empties the trash when parents and children are in it together', async () => {
    const { l1 } = await threeLevels();
    await softDeleteSubtree(l1.id);
    const outcome = await purgeAllDeleted();
    expect(outcome.recordsPurged).toBe(4);
    await expectValid();
  });
});

describe('concurrent hierarchy mutations', () => {
  /** Run two operations at the same instant; report which ones succeeded. */
  async function race(a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<boolean[]> {
    const outcomes = await Promise.allSettled([a(), b()]);
    return outcomes.map((outcome) => outcome.status === 'fulfilled');
  }

  it.each([false, true])(
    'adding a child and trashing its parent never leave a live child under a trashed parent (swapped: %s)',
    async (swapped) => {
      const parent = await create('上级');
      const addChild = () => create('新增的下级', parent.id);
      const trashParent = () => softDeleteRecord(parent.id);
      const results = swapped
        ? await race(trashParent, addChild)
        : await race(addChild, trashParent);
      expect(results.filter(Boolean)).toHaveLength(1);
      const all = (await records()).filter(isWorkRecord);
      const trashed = new Set(all.filter((r) => r.deletedAt !== null).map((r) => r.id));
      expect(
        all.some(
          (r) => r.deletedAt === null && r.parentWorkId !== null && trashed.has(r.parentWorkId),
        ),
      ).toBe(false);
      await expectValid();
    },
  );

  it.each([false, true])(
    'moving A under B while B moves under A cannot create a cycle (swapped: %s)',
    async (swapped) => {
      const a = await create('甲');
      const b = await create('乙');
      const aUnderB = () => moveWorkRecord(a.id, b.id);
      const bUnderA = () => moveWorkRecord(b.id, a.id);
      const results = swapped ? await race(bUnderA, aUnderB) : await race(aUnderB, bUnderA);
      expect(results.filter(Boolean)).toHaveLength(1);
      await expectValid();
    },
  );

  it.each([false, true])(
    'adding a level-3 child while its parent moves down a level cannot exceed three levels (swapped: %s)',
    async (swapped) => {
      const root = await create('根');
      const b = await create('乙', root.id);
      const otherRoot = await create('另一个根');
      const c = await create('丙', otherRoot.id);
      const addUnderB = () => create('乙的下级', b.id);
      const moveBUnderC = () => moveWorkRecord(b.id, c.id);
      const results = swapped
        ? await race(moveBUnderC, addUnderB)
        : await race(addUnderB, moveBUnderC);
      expect(results.filter(Boolean)).toHaveLength(1);
      await expectValid();
    },
  );

  it('fixtures can seed an arbitrary tree directly, and the validator agrees with the repositories', async () => {
    await db.records.bulkAdd([
      makeWork({ id: 'r' }),
      makeWork({ id: 'c', parentWorkId: 'r' }),
      makeWork({ id: 'g', parentWorkId: 'c' }),
    ]);
    expect(await refusal(create('第四级', 'g'))).toBe('too-deep');
    await expectValid();
  });
});
