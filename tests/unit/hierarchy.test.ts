import { describe, expect, it } from 'vitest';
import {
  MAX_WORK_DEPTH,
  WORK_LEVEL_LABELS_ZH,
  ancestryOf,
  buildHierarchyIndex,
  canCreateUnder,
  canMove,
  descendantsOf,
  describeHierarchyRefusal,
  eligibleParents,
  findHierarchyError,
  HierarchyError,
  subtreeHeight,
  validateHierarchy,
} from '@/domain/hierarchy';
import type { HierarchyRecord, HierarchyRefusal } from '@/domain/hierarchy';

/**
 * The work hierarchy's structural rules, over plain objects.
 *
 * The same functions back the integrity validator (restore, merge, diagnostics, backup viability) and
 * the repositories' write checks, so every defect class is pinned here once, including the ones only a
 * damaged archive can contain.
 */

function work(id: string, parentWorkId: string | null = null, deletedAt: string | null = null) {
  return { id, kind: 'work' as const, title: `任务${id}`, parentWorkId, deletedAt };
}

function honor(id: string): HierarchyRecord {
  return { id, kind: 'honor', title: `荣誉${id}`, deletedAt: null };
}

/** L1 → L2a → (L3a, L3b); L1 → L2b; plus an unrelated root. */
function tree(): HierarchyRecord[] {
  return [
    work('L1'),
    work('L2a', 'L1'),
    work('L2b', 'L1'),
    work('L3a', 'L2a'),
    work('L3b', 'L2a'),
    work('other'),
    honor('H'),
  ];
}

describe('labels and limits', () => {
  it('names three levels by relationship, not by a typed number', () => {
    expect(MAX_WORK_DEPTH).toBe(3);
    expect(WORK_LEVEL_LABELS_ZH).toEqual({ 1: '1级任务', 2: '2级子任务', 3: '3级子任务' });
  });
});

describe('validateHierarchy', () => {
  it('accepts a valid three-level forest', () => {
    expect(validateHierarchy(tree())).toEqual([]);
  });

  it('accepts a soft-deleted parent: the row exists and travels in backups', () => {
    expect(
      validateHierarchy([work('P', null, '2026-09-01T00:00:00.000Z'), work('C', 'P')]),
    ).toEqual([]);
  });

  it('reports a dangling parent on the record that names it, and nothing beneath it', () => {
    const issues = validateHierarchy([work('B', 'gone'), work('C', 'B'), work('D', 'C')]);
    expect(issues).toEqual([{ kind: 'dangling-parent-work', id: 'B', reference: 'gone' }]);
  });

  it('reports an honour used as a parent', () => {
    expect(validateHierarchy([honor('H'), work('C', 'H')])).toEqual([
      { kind: 'parent-is-not-work', id: 'C', reference: 'H' },
    ]);
  });

  it('reports a self-parent as a cycle of one', () => {
    expect(validateHierarchy([work('S', 'S')])).toEqual([
      { kind: 'work-hierarchy-cycle', id: 'S', reference: 'S' },
    ]);
  });

  it('reports every member of a longer cycle once, and not the records feeding into it', () => {
    const issues = validateHierarchy([
      work('F', 'A'),
      work('A', 'B'),
      work('B', 'C'),
      work('C', 'A'),
    ]);
    expect(issues.map((issue) => issue.kind)).toEqual([
      'work-hierarchy-cycle',
      'work-hierarchy-cycle',
      'work-hierarchy-cycle',
    ]);
    expect(issues.map((issue) => issue.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('reports every record deeper than the cap', () => {
    const chain = [work('1'), work('2', '1'), work('3', '2'), work('4', '3'), work('5', '4')];
    expect(validateHierarchy(chain)).toEqual([
      { kind: 'work-hierarchy-too-deep', id: '4', reference: '3' },
      { kind: 'work-hierarchy-too-deep', id: '5', reference: '4' },
    ]);
  });

  it('gives the same answer whatever order the records arrive in', () => {
    const chain = [work('1'), work('2', '1'), work('3', '2'), work('4', '3'), work('x', 'gone')];
    const forward = validateHierarchy(chain);
    const backward = validateHierarchy([...chain].reverse());
    const key = (issues: typeof forward) => issues.map((i) => `${i.kind}:${i.id}`).sort();
    expect(key(backward)).toEqual(key(forward));
  });

  it('ignores a parent field on an honour — the schema, not this rule, rejects that', () => {
    const odd = { ...honor('H'), parentWorkId: 'L1' };
    expect(validateHierarchy([work('L1'), odd])).toEqual([]);
  });

  it('stays linear on a corrupt 5,000-deep chain', () => {
    const chain = Array.from({ length: 5000 }, (_, i) =>
      work(`n${String(i)}`, i === 0 ? null : `n${String(i - 1)}`),
    );
    const started = performance.now();
    const issues = validateHierarchy([...chain].reverse());
    const elapsed = performance.now() - started;
    expect(issues).toHaveLength(5000 - MAX_WORK_DEPTH);
    expect(issues.every((issue) => issue.kind === 'work-hierarchy-too-deep')).toBe(true);
    // A generous ceiling: quadratic behaviour here would take seconds, linear takes milliseconds.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('ancestry, descendants and height', () => {
  const index = buildHierarchyIndex(tree());

  it('derives the level from the chain', () => {
    expect(ancestryOf(index, 'L1')).toEqual({ ancestors: [], level: 1 });
    expect(ancestryOf(index, 'L2a').level).toBe(2);
    const deep = ancestryOf(index, 'L3b');
    expect(deep.level).toBe(3);
    expect(deep.ancestors.map((record) => record.id)).toEqual(['L1', 'L2a']);
  });

  it('returns no level, but partial context, for a broken chain', () => {
    const broken = buildHierarchyIndex([work('A', 'gone'), work('B', 'A')]);
    expect(ancestryOf(broken, 'B')).toEqual({ ancestors: [work('A', 'gone')], level: null });
    const cyclic = buildHierarchyIndex([work('A', 'B'), work('B', 'A')]);
    expect(ancestryOf(cyclic, 'A').level).toBeNull();
    expect(ancestryOf(index, 'H').level).toBeNull();
  });

  it('lists descendants breadth-first, including soft-deleted ones, and survives cycles', () => {
    expect(descendantsOf(index, 'L1').map((record) => record.id)).toEqual([
      'L2a',
      'L2b',
      'L3a',
      'L3b',
    ]);
    const withTrash = buildHierarchyIndex([work('P'), work('C', 'P', '2026-09-01T00:00:00.000Z')]);
    expect(descendantsOf(withTrash, 'P').map((record) => record.id)).toEqual(['C']);
    const cyclic = buildHierarchyIndex([work('A', 'B'), work('B', 'A')]);
    expect(descendantsOf(cyclic, 'A').map((record) => record.id)).toEqual(['B']);
  });

  it('measures subtree height in levels', () => {
    expect(subtreeHeight(index, 'L3a')).toBe(1);
    expect(subtreeHeight(index, 'L2a')).toBe(2);
    expect(subtreeHeight(index, 'L1')).toBe(3);
  });
});

describe('write-time verdicts', () => {
  const trashed = '2026-09-01T00:00:00.000Z';
  const index = buildHierarchyIndex([...tree(), work('gone-parent', null, trashed)]);
  const refused = (verdict: ReturnType<typeof canMove>): HierarchyRefusal | null =>
    verdict.ok ? null : verdict.reason;

  it('allows a new top-level task and a child of a level-1 or level-2 task', () => {
    expect(canCreateUnder(index, null)).toEqual({ ok: true });
    expect(canCreateUnder(index, 'L1')).toEqual({ ok: true });
    expect(canCreateUnder(index, 'L2a')).toEqual({ ok: true });
  });

  it('refuses a fourth level, a missing parent, an honour parent and a trashed parent', () => {
    expect(refused(canCreateUnder(index, 'L3a'))).toBe('too-deep');
    expect(refused(canCreateUnder(index, 'nope'))).toBe('parent-missing');
    expect(refused(canCreateUnder(index, 'H'))).toBe('parent-not-work');
    expect(refused(canCreateUnder(index, 'gone-parent'))).toBe('parent-deleted');
  });

  it('refuses a parent whose own chain is broken', () => {
    const broken = buildHierarchyIndex([work('A', 'gone'), work('B')]);
    expect(refused(canCreateUnder(broken, 'A'))).toBe('parent-chain-broken');
  });

  it('allows moves that keep the projected tree within three levels', () => {
    expect(canMove(index, 'L2b', 'L2a')).toEqual({ ok: true });
    expect(canMove(index, 'L3a', null)).toEqual({ ok: true });
    expect(canMove(index, 'other', 'L2a')).toEqual({ ok: true });
  });

  it('refuses self, descendant, over-depth and unavailable targets', () => {
    expect(refused(canMove(index, 'L1', 'L1'))).toBe('parent-is-self');
    expect(refused(canMove(index, 'L1', 'L3a'))).toBe('parent-is-descendant');
    // L2a carries a level below it, so under L2b it would reach level 4.
    expect(refused(canMove(index, 'L2a', 'L2b'))).toBe('too-deep');
    expect(refused(canMove(index, 'L2a', 'H'))).toBe('parent-not-work');
    expect(refused(canMove(index, 'L2a', 'gone-parent'))).toBe('parent-deleted');
    expect(refused(canMove(index, 'H', null))).toBe('record-not-work');
    expect(refused(canMove(index, 'nope', null))).toBe('record-missing');
    expect(refused(canMove(index, 'gone-parent', 'L1'))).toBe('record-deleted');
  });

  it('counts soft-deleted descendants towards the moved subtree', () => {
    const withTrashedLeaf = buildHierarchyIndex([
      work('A'),
      work('B', 'A'),
      work('C', 'B', trashed),
      work('T'),
      work('U', 'T'),
    ]);
    // B's subtree is two levels including the trashed C; under U (level 2) it would reach level 4.
    expect(refused(canMove(withTrashedLeaf, 'B', 'U'))).toBe('too-deep');
  });

  it('has a user-facing message for every refusal', () => {
    const reasons: HierarchyRefusal[] = [
      'record-missing',
      'record-not-work',
      'record-deleted',
      'parent-missing',
      'parent-not-work',
      'parent-deleted',
      'parent-is-self',
      'parent-is-descendant',
      'parent-chain-broken',
      'too-deep',
    ];
    for (const reason of reasons)
      expect(describeHierarchyRefusal(reason)).toMatch(/\p{Script=Han}/u);
  });
});

describe('eligible parents', () => {
  it('equals the set of targets canMove accepts, for every record', () => {
    const trashed = '2026-09-01T00:00:00.000Z';
    const records = [
      ...tree(),
      work('deep-root'),
      work('deep-2', 'deep-root'),
      work('gone', null, trashed),
      work('broken', 'nowhere'),
    ];
    const index = buildHierarchyIndex(records);
    for (const record of records) {
      const expected = records
        .filter((candidate) => canMove(index, record.id, candidate.id).ok)
        .map((candidate) => candidate.id)
        .sort();
      const actual = eligibleParents(index, record.id)
        .map((candidate) => candidate.id)
        .sort();
      expect(actual, `targets for ${record.id}`).toEqual(expected);
    }
  });
});

describe('findHierarchyError', () => {
  it('finds a refusal inside a wrapper, and nothing else', () => {
    const refusal = new HierarchyError('too-deep');
    const wrapped = new Error('moveWorkRecord failed: …', { cause: refusal });
    expect(findHierarchyError(wrapped)).toBe(refusal);
    expect(findHierarchyError(new Error('other'))).toBeNull();
    expect(refusal.message).toBe(describeHierarchyRefusal('too-deep'));
  });
});
