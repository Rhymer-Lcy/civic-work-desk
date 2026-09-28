import { evaluateDeadline } from './deadlines';
import type { IsoDate } from './dates';
import { ancestryOf, buildHierarchyIndex, descendantsOf, parentIdOf } from './hierarchy';
import type { HierarchyIndex, WorkLevel } from './hierarchy';
import { isOpenStatus } from './status';
import { isWorkRecord } from './types';
import type { AnyRecord, WorkRecord } from './types';

/**
 * Derived hierarchy facts for display: progress, descendant deadlines, context paths and the forest the
 * structure view draws.
 *
 * **Nothing here is stored** (docs/phase-5-product-evolution.md §6). A parent's status and deadlines
 * are its own; these summaries only describe its descendants, and they are recomputed from the current
 * records every time, so they cannot drift from what they summarise.
 */

export type WorkIndex = HierarchyIndex<AnyRecord>;

export function indexRecords(records: readonly AnyRecord[]): WorkIndex {
  return buildHierarchyIndex(records);
}

function liveWorkChildren(index: WorkIndex, id: string): WorkRecord[] {
  return (index.children.get(id) ?? []).filter(
    (child): child is WorkRecord => isWorkRecord(child) && child.deletedAt === null,
  );
}

function liveWorkDescendants(index: WorkIndex, id: string): WorkRecord[] {
  return descendantsOf(index, id).filter(
    (record): record is WorkRecord => isWorkRecord(record) && record.deletedAt === null,
  );
}

/* ------------------------------------------------------------- progress */

export interface ChildProgress {
  /** Live direct children. */
  readonly total: number;
  readonly completed: number;
  readonly cancelled: number;
}

/** Direct, live children only: each level reports on the level below it. */
export function childProgress(index: WorkIndex, id: string): ChildProgress {
  const children = liveWorkChildren(index, id);
  return {
    total: children.length,
    completed: children.filter((child) => child.status === 'completed').length,
    cancelled: children.filter((child) => child.status === 'cancelled').length,
  };
}

/**
 * 「下级任务 2/3 已完成」.
 *
 * Cancelled children leave the denominator — the same rule as the report completion rate — and are
 * mentioned so the smaller denominator is explained rather than surprising. Null when there are none.
 */
export function describeChildProgress(progress: ChildProgress): string | null {
  if (progress.total === 0) return null;
  const counted = progress.total - progress.cancelled;
  if (counted === 0) return `下级任务 ${String(progress.cancelled)} 项均已取消`;
  const base = `下级任务 ${String(progress.completed)}/${String(counted)} 已完成`;
  return progress.cancelled > 0 ? `${base}（另有 ${String(progress.cancelled)} 项已取消）` : base;
}

/** Live descendants that are still open (待办 / 进行中 / 已推迟). */
export function openDescendants(index: WorkIndex, id: string): WorkRecord[] {
  return liveWorkDescendants(index, id).filter((record) => isOpenStatus(record.status));
}

/**
 * The notice shown before a parent is marked 已完成 while descendants are still open, or null.
 *
 * Non-destructive by design: completing a parent never touches a child, so the notice says so.
 */
export function completionNotice(index: WorkIndex, id: string): string | null {
  const open = openDescendants(index, id).length;
  if (open === 0) return null;
  return `该任务还有 ${String(open)} 项下级任务尚未完成。仍将本任务标记为已完成吗？下级任务的状态不会改变。`;
}

/* ------------------------------------------------------------ deadlines */

export interface DescendantDeadlines {
  /** Open, live descendants whose driving deadline has passed. */
  readonly overdue: number;
  /** The earliest deadline among open, live descendants that has not passed yet. */
  readonly nearest: { readonly day: IsoDate; readonly title: string } | null;
}

export function descendantDeadlines(
  index: WorkIndex,
  id: string,
  today: IsoDate,
): DescendantDeadlines {
  let overdue = 0;
  let nearest: { day: IsoDate; title: string } | null = null;
  for (const record of openDescendants(index, id)) {
    const verdict = evaluateDeadline(record, today);
    if (verdict.level === 'overdue') {
      overdue += 1;
      continue;
    }
    if (verdict.day !== null && (nearest === null || verdict.day < nearest.day)) {
      nearest = { day: verdict.day, title: record.title };
    }
  }
  return { overdue, nearest };
}

/* --------------------------------------------------------------- context */

export interface HierarchyContext {
  readonly level: WorkLevel | null;
  /** Ancestors, top-level task first. */
  readonly ancestors: readonly WorkRecord[];
  /** The parent exists but is in the trash — the record is shown at the top level with a note. */
  readonly parentInTrash: WorkRecord | null;
}

export function hierarchyContext(index: WorkIndex, id: string): HierarchyContext {
  const { ancestors, level } = ancestryOf(index, id);
  const works = ancestors.filter(isWorkRecord);
  const record = index.byId.get(id);
  const parentId = record ? parentIdOf(record) : null;
  const parent = parentId === null ? undefined : index.byId.get(parentId);
  return {
    level,
    ancestors: works,
    parentInTrash:
      parent !== undefined && isWorkRecord(parent) && parent.deletedAt !== null ? parent : null,
  };
}

/** 「一级任务 / 二级子任务」 — ancestor titles, built by id, never by title. */
export function describePath(ancestors: readonly WorkRecord[]): string {
  return ancestors.map((record) => record.title).join(' / ');
}

/* ------------------------------------------------------------- the forest */

export interface StructureNode {
  readonly record: WorkRecord;
  readonly level: WorkLevel | null;
  /** Shown only so that a matching descendant keeps its context; did not match the filter itself. */
  readonly context: boolean;
  /** The parent is in the trash, so this node is drawn at the top level (docs §4.4). */
  readonly parentInTrash: WorkRecord | null;
  readonly children: readonly StructureNode[];
}

/**
 * The forest the structure view draws, from the list the one query engine produced.
 *
 * `matched` is `runQuery`'s result, already filtered and sorted. Every matched record is shown; each of
 * its live ancestors that did not match is added as **context**, so a matching sub-task is never shown
 * without the path that explains it, and never hidden because its parent did not match. Siblings keep the
 * order of `matched`; a context node takes the position of its first matching descendant. O(n · depth).
 */
export function buildStructureForest(
  index: WorkIndex,
  matched: readonly WorkRecord[],
): StructureNode[] {
  const rank = new Map<string, number>();
  matched.forEach((record, position) => rank.set(record.id, position));
  const matchedIds = new Set(rank.keys());
  const shown = new Map<string, WorkRecord>();

  for (const record of matched) {
    shown.set(record.id, record);
    const { ancestors } = ancestryOf(index, record.id);
    // Walk upward from the parent; stop at anything not live, so nothing is shown under a trashed node.
    for (let i = ancestors.length - 1; i >= 0; i -= 1) {
      const ancestor = ancestors[i];
      if (ancestor === undefined || !isWorkRecord(ancestor) || ancestor.deletedAt !== null) break;
      shown.set(ancestor.id, ancestor);
      const current = rank.get(ancestor.id);
      const candidate = rank.get(record.id) ?? Number.MAX_SAFE_INTEGER;
      if (current === undefined || candidate < current) rank.set(ancestor.id, candidate);
    }
  }

  const childrenOf = new Map<string | null, WorkRecord[]>();
  for (const record of shown.values()) {
    const parentId = record.parentWorkId;
    const key = parentId !== null && shown.has(parentId) ? parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(record);
    else childrenOf.set(key, [record]);
  }
  const order = (a: WorkRecord, b: WorkRecord): number =>
    (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER);

  const build = (record: WorkRecord, guard: Set<string>): StructureNode => {
    const next = new Set(guard).add(record.id);
    const kids = (childrenOf.get(record.id) ?? [])
      .filter((child) => !next.has(child.id))
      .sort(order);
    return {
      record,
      level: ancestryOf(index, record.id).level,
      context: !matchedIds.has(record.id),
      parentInTrash: hierarchyContext(index, record.id).parentInTrash,
      children: kids.map((child) => build(child, next)),
    };
  };

  return (childrenOf.get(null) ?? []).sort(order).map((record) => build(record, new Set()));
}
