import { describe, expect, it } from 'vitest';
import {
  buildStructureForest,
  childProgress,
  completionNotice,
  describeChildProgress,
  describePath,
  descendantDeadlines,
  hierarchyContext,
  indexRecords,
} from '@/domain/hierarchy-summary';
import type { StructureNode } from '@/domain/hierarchy-summary';
import { EMPTY_QUERY, runQuery } from '@/domain/query';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord } from '@/domain/types';
import { makeHonor, makeWork, plain } from '../fixtures/records';

/**
 * Derived hierarchy facts. None of them is stored; each is recomputed from the records, so these tests
 * pin the definitions: which records count, and which do not.
 */

const TODAY = '2026-09-20';
const TRASHED = '2026-09-01T00:00:00.000Z';

/** 一级 → (二级甲 → (三级甲, 三级乙), 二级乙, 二级丙[已取消]) plus a separate root. Duplicate titles on purpose. */
function archive(): AnyRecord[] {
  return [
    makeWork({ id: 'root', title: '一级任务', occurredOn: plain('2026-09-01') }),
    makeWork({
      id: 'a',
      title: '同名子任务',
      parentWorkId: 'root',
      occurredOn: plain('2026-09-02'),
    }),
    makeWork({
      id: 'b',
      title: '二级乙',
      parentWorkId: 'root',
      status: 'completed',
      occurredOn: plain('2026-09-03'),
    }),
    makeWork({
      id: 'c',
      title: '二级丙',
      parentWorkId: 'root',
      status: 'cancelled',
      occurredOn: plain('2026-09-04'),
    }),
    makeWork({
      id: 'a1',
      title: '同名子任务',
      parentWorkId: 'a',
      reportDeadline: plain('2026-09-10'),
      occurredOn: plain('2026-09-05'),
    }),
    makeWork({
      id: 'a2',
      title: '三级乙',
      parentWorkId: 'a',
      completionDeadline: plain('2026-09-25'),
      occurredOn: plain('2026-09-06'),
    }),
    makeWork({
      id: 'trashed-child',
      title: '已删的下级',
      parentWorkId: 'root',
      deletedAt: TRASHED,
    }),
    makeWork({ id: 'other', title: '另一个一级任务', occurredOn: plain('2026-09-07') }),
    makeHonor({ id: 'h', relatedWorkId: 'a1' }),
  ];
}

function shape(nodes: readonly StructureNode[]): unknown[] {
  return nodes.map((node) => ({
    id: node.record.id,
    level: node.level,
    ...(node.context ? { context: true } : {}),
    ...(node.children.length > 0 ? { children: shape(node.children) } : {}),
  }));
}

describe('progress and the completion notice', () => {
  const index = indexRecords(archive());

  it('counts live direct children, and takes cancelled ones out of the denominator', () => {
    const progress = childProgress(index, 'root');
    expect(progress).toEqual({ total: 3, completed: 1, cancelled: 1 });
    expect(describeChildProgress(progress)).toBe('下级任务 1/2 已完成（另有 1 项已取消）');
    expect(describeChildProgress(childProgress(index, 'a'))).toBe('下级任务 0/2 已完成');
    expect(describeChildProgress(childProgress(index, 'a1'))).toBeNull();
    expect(describeChildProgress({ total: 2, completed: 0, cancelled: 2 })).toBe(
      '下级任务 2 项均已取消',
    );
  });

  it('warns before completing a parent with open descendants at any depth, and only then', () => {
    expect(completionNotice(index, 'root')).toContain('3 项下级任务尚未完成');
    expect(completionNotice(index, 'root')).toContain('下级任务的状态不会改变');
    expect(completionNotice(index, 'a')).toContain('2 项');
    expect(completionNotice(index, 'b')).toBeNull();
  });
});

describe('descendant deadlines', () => {
  it('counts overdue open descendants and names the nearest one still ahead', () => {
    const index = indexRecords(archive());
    expect(descendantDeadlines(index, 'root', TODAY)).toEqual({
      overdue: 1,
      nearest: { day: '2026-09-25', title: '三级乙' },
    });
    expect(descendantDeadlines(index, 'other', TODAY)).toEqual({ overdue: 0, nearest: null });
  });
});

describe('context for a single record', () => {
  it('derives the level and the path by id, not by title', () => {
    const index = indexRecords(archive());
    const context = hierarchyContext(index, 'a1');
    expect(context.level).toBe(3);
    expect(describePath(context.ancestors)).toBe('一级任务 / 同名子任务');
    expect(context.parentInTrash).toBeNull();
  });

  it('notices a parent in the trash', () => {
    const index = indexRecords([
      makeWork({ id: 'p', deletedAt: TRASHED }),
      makeWork({ id: 'kid', parentWorkId: 'p' }),
    ]);
    expect(hierarchyContext(index, 'kid').parentInTrash?.id).toBe('p');
  });
});

describe('the structure forest', () => {
  const records = archive();
  const index = indexRecords(records);
  const query = (search: string) =>
    runQuery(
      records,
      { ...EMPTY_QUERY, kind: 'work', sort: 'date-asc', search },
      { today: TODAY },
    ).filter(isWorkRecord);

  it('without a filter, draws every live task in its place, in the list order', () => {
    expect(shape(buildStructureForest(index, query('')))).toEqual([
      {
        id: 'root',
        level: 1,
        children: [
          {
            id: 'a',
            level: 2,
            children: [
              { id: 'a1', level: 3 },
              { id: 'a2', level: 3 },
            ],
          },
          { id: 'b', level: 2 },
          { id: 'c', level: 2 },
        ],
      },
      { id: 'other', level: 1 },
    ]);
  });

  it('with a filter, shows each match with its ancestors as context and hides unmatched siblings', () => {
    expect(shape(buildStructureForest(index, query('三级乙')))).toEqual([
      {
        id: 'root',
        level: 1,
        context: true,
        children: [{ id: 'a', level: 2, context: true, children: [{ id: 'a2', level: 3 }] }],
      },
    ]);
  });

  it('a match on a parent does not drag in children that did not match', () => {
    expect(shape(buildStructureForest(index, query('另一个')))).toEqual([
      { id: 'other', level: 1 },
    ]);
  });

  it('duplicate titles in different branches stay two nodes', () => {
    const nodes = shape(buildStructureForest(index, query('同名子任务')));
    expect(nodes).toEqual([
      {
        id: 'root',
        level: 1,
        context: true,
        children: [{ id: 'a', level: 2, children: [{ id: 'a1', level: 3 }] }],
      },
    ]);
  });

  it('draws a live child of a trashed parent at the top level, with the parent named', () => {
    const tolerated = [
      makeWork({ id: 'p', deletedAt: TRASHED }),
      makeWork({ id: 'kid', parentWorkId: 'p' }),
    ];
    const forest = buildStructureForest(
      indexRecords(tolerated),
      runQuery(tolerated, { ...EMPTY_QUERY, kind: 'work' }).filter(isWorkRecord),
    );
    expect(forest.map((node) => node.record.id)).toEqual(['kid']);
    expect(forest[0]?.parentInTrash?.id).toBe('p');
  });
});
