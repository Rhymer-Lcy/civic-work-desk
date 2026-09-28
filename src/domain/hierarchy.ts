/**
 * Work hierarchy: decomposition of a task into sub-tasks, at most three levels deep.
 *
 * **Nodes are ordinary work records.** A sub-task is a `WorkRecord` whose `parentWorkId` names another
 * work record; there is no nested `subtasks[]` array and no second record type, so a sub-task has every
 * field a task has — its own status, both deadlines, category, group and progress notes — and every
 * view, filter, report and backup already knows how to carry it. (The prototype's friend-maintained
 * successor kept a flat `subtasks[]` inside each record, which gives a sub-task none of that.)
 *
 * **Depth is derived, never stored.** A top-level task is level 1; a record's level is its parent's
 * plus one. A stored `level` would be a second source of truth that a re-parent could leave stale.
 *
 * **Everything here is pure** and works over the structural `HierarchyRecord`, so the same rules serve
 * the integrity validator (restore, merge, diagnostics, backup viability), the repositories' write
 * checks and the views. Chains are walked iteratively with a visited set, so corrupt data — a cycle, a
 * chain far deeper than the cap — can make a record *invalid* but can never make a walk loop or recurse.
 */

/** The deepest level a work record may sit at. Level 1 is a top-level task. */
export const MAX_WORK_DEPTH = 3;

export type WorkLevel = 1 | 2 | 3;

/** User-facing names. The relationship decides the label; nobody types a level number. */
export const WORK_LEVEL_LABELS_ZH: Readonly<Record<WorkLevel, string>> = Object.freeze({
  1: '1级任务',
  2: '2级子任务',
  3: '3级子任务',
});

export function isWorkLevel(value: number): value is WorkLevel {
  return value === 1 || value === 2 || value === 3;
}

/** The fields hierarchy rules read. Both record kinds satisfy it; only work records carry a parent. */
export interface HierarchyRecord {
  readonly id: string;
  readonly kind: 'work' | 'honor';
  readonly title: string;
  readonly parentWorkId?: string | null;
  readonly deletedAt: string | null;
}

/** The parent a record names, or null. An honour never names one. */
export function parentIdOf(record: HierarchyRecord): string | null {
  return record.kind === 'work' ? (record.parentWorkId ?? null) : null;
}

/* ------------------------------------------------------------------ index */

export interface HierarchyIndex<T extends HierarchyRecord> {
  /** First record for each id. Duplicate ids are an integrity issue reported elsewhere. */
  readonly byId: ReadonlyMap<string, T>;
  /** Records naming each parent id, in input order, soft-deleted ones included. */
  readonly children: ReadonlyMap<string, readonly T[]>;
}

/** One pass, O(n). */
export function buildHierarchyIndex<T extends HierarchyRecord>(
  records: readonly T[],
): HierarchyIndex<T> {
  const byId = new Map<string, T>();
  const children = new Map<string, T[]>();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
    const parentId = parentIdOf(record);
    if (parentId === null) continue;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(record);
    else children.set(parentId, [record]);
  }
  return { byId, children };
}

/* -------------------------------------------------------------- integrity */

export type HierarchyIssueKind =
  | 'dangling-parent-work'
  | 'parent-is-not-work'
  | 'work-hierarchy-cycle'
  | 'work-hierarchy-too-deep';

export interface HierarchyIssue {
  readonly kind: HierarchyIssueKind;
  /** The record whose `parentWorkId` is at fault. */
  readonly id: string;
  /** The parent id it names. */
  readonly reference: string;
}

const BROKEN = -1;

/**
 * Every hierarchy defect in a complete state, in a deterministic order. O(n).
 *
 * Each record is classified once and the result memoised, so a chain shared by many records is walked
 * once. The rules:
 *
 *   - a parent that does not exist → `dangling-parent-work` on the record naming it;
 *   - a parent that is not a work record → `parent-is-not-work`;
 *   - a record on a cycle (its own parent included) → `work-hierarchy-cycle`, once per member;
 *   - a record deeper than `MAX_WORK_DEPTH` → `work-hierarchy-too-deep`, for every such record;
 *   - a record whose chain runs into one of the defects above is not reported again: the defect is
 *     reported where it is, and fixing it is what repairs everything beneath it.
 *
 * A soft-deleted parent satisfies the reference, as every other reference rule in this codebase does:
 * the row exists and travels in backups.
 */
export function validateHierarchy(records: readonly HierarchyRecord[]): HierarchyIssue[] {
  const { byId } = buildHierarchyIndex(records);
  const issues: HierarchyIssue[] = [];
  const depth = new Map<string, number>();

  for (const start of records) {
    if (start.kind !== 'work' || depth.has(start.id)) continue;

    // Walk upward, collecting records whose depth is not known yet, until the chain resolves.
    const path: HierarchyRecord[] = [];
    const onPath = new Map<string, number>();
    let current: HierarchyRecord = start;
    let base: number;
    for (;;) {
      const known = depth.get(current.id);
      if (known !== undefined) {
        base = known;
        break;
      }
      const seenAt = onPath.get(current.id);
      if (seenAt !== undefined) {
        for (const member of path.slice(seenAt)) {
          issues.push({
            kind: 'work-hierarchy-cycle',
            id: member.id,
            reference: parentIdOf(member) ?? '',
          });
          depth.set(member.id, BROKEN);
        }
        path.length = seenAt;
        base = BROKEN;
        break;
      }
      onPath.set(current.id, path.length);
      path.push(current);
      const parentId = parentIdOf(current);
      if (parentId === null) {
        base = 0;
        break;
      }
      const parent = byId.get(parentId);
      if (parent?.kind !== 'work') {
        issues.push({
          kind: parent === undefined ? 'dangling-parent-work' : 'parent-is-not-work',
          id: current.id,
          reference: parentId,
        });
        path.pop();
        depth.set(current.id, BROKEN);
        base = BROKEN;
        break;
      }
      current = parent;
    }

    // Assign depths back down the path, topmost first.
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const node = path[index];
      if (node === undefined) continue;
      if (base === BROKEN) {
        depth.set(node.id, BROKEN);
        continue;
      }
      base += 1;
      depth.set(node.id, base);
      if (base > MAX_WORK_DEPTH) {
        issues.push({
          kind: 'work-hierarchy-too-deep',
          id: node.id,
          reference: parentIdOf(node) ?? '',
        });
      }
    }
  }
  return issues;
}

/* ---------------------------------------------------------------- queries */

export interface Ancestry<T extends HierarchyRecord> {
  /** Root first, parent last. Empty for a top-level record. */
  readonly ancestors: readonly T[];
  /** The record's level, or null when its chain is broken or deeper than the cap. */
  readonly level: WorkLevel | null;
}

/**
 * The ancestors of one record and its level.
 *
 * Bounded: the walk stops after `MAX_WORK_DEPTH` steps, so a corrupt chain costs at most that much. A
 * chain that is broken — a missing or non-work parent, a cycle, or more ancestors than the cap allows —
 * yields `level: null` and whatever ancestors were found before the break, so a view can still show
 * partial context.
 */
export function ancestryOf<T extends HierarchyRecord>(
  index: HierarchyIndex<T>,
  id: string,
): Ancestry<T> {
  const record = index.byId.get(id);
  if (record?.kind !== 'work') return { ancestors: [], level: null };
  const upward: T[] = [];
  const seen = new Set<string>([record.id]);
  let parentId = parentIdOf(record);
  while (parentId !== null) {
    const parent = index.byId.get(parentId);
    if (parent?.kind !== 'work' || seen.has(parent.id) || upward.length >= MAX_WORK_DEPTH) {
      return { ancestors: upward.reverse(), level: null };
    }
    seen.add(parent.id);
    upward.push(parent);
    parentId = parentIdOf(parent);
  }
  const level = upward.length + 1;
  return { ancestors: upward.reverse(), level: isWorkLevel(level) ? level : null };
}

/** All descendants, breadth-first, soft-deleted included. Safe on cycles. */
export function descendantsOf<T extends HierarchyRecord>(
  index: HierarchyIndex<T>,
  id: string,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>([id]);
  let frontier: readonly string[] = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of index.children.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return out;
}

/** How many levels the subtree rooted at `id` spans: 1 for a leaf. Safe on cycles. */
export function subtreeHeight<T extends HierarchyRecord>(
  index: HierarchyIndex<T>,
  id: string,
): number {
  let height = 1;
  const seen = new Set<string>([id]);
  let frontier: readonly string[] = [id];
  for (;;) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of index.children.get(parentId) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        next.push(child.id);
      }
    }
    if (next.length === 0) return height;
    height += 1;
    frontier = next;
  }
}

/* ------------------------------------------------------ write-time verdicts */

export type HierarchyRefusal =
  | 'record-missing'
  | 'record-not-work'
  | 'record-deleted'
  | 'parent-missing'
  | 'parent-not-work'
  | 'parent-deleted'
  | 'parent-is-self'
  | 'parent-is-descendant'
  | 'parent-chain-broken'
  | 'too-deep';

export type HierarchyVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: HierarchyRefusal };

const OK: HierarchyVerdict = Object.freeze({ ok: true });

function refuse(reason: HierarchyRefusal): HierarchyVerdict {
  return { ok: false, reason };
}

/** Whether `parentId` may receive a child at all: it exists, is live work, and has room below it. */
function parentVerdict<T extends HierarchyRecord>(
  index: HierarchyIndex<T>,
  parentId: string,
  levelsBelow: number,
): HierarchyVerdict {
  const parent = index.byId.get(parentId);
  if (parent === undefined) return refuse('parent-missing');
  if (parent.kind !== 'work') return refuse('parent-not-work');
  if (parent.deletedAt !== null) return refuse('parent-deleted');
  const { level } = ancestryOf(index, parentId);
  if (level === null) return refuse('parent-chain-broken');
  return level + levelsBelow > MAX_WORK_DEPTH ? refuse('too-deep') : OK;
}

/** May a new work record be created under `parentId`? (`null` — a top-level task — always may.) */
export function canCreateUnder<T extends HierarchyRecord>(
  index: HierarchyIndex<T>,
  parentId: string | null,
): HierarchyVerdict {
  return parentId === null ? OK : parentVerdict(index, parentId, 1);
}

/**
 * May `id` be moved under `newParentId` (or to the top level, with `null`)?
 *
 * The verdict is about the **projected final tree**: the whole subtree moves with the record, so the
 * depth that matters is the new parent's level plus the subtree's height, and a new parent inside the
 * subtree would close a cycle. Soft-deleted descendants count — they are rows in the tree, and restoring
 * one must not produce a path longer than the cap.
 */
export function canMove<T extends HierarchyRecord>(
  index: HierarchyIndex<T>,
  id: string,
  newParentId: string | null,
): HierarchyVerdict {
  const record = index.byId.get(id);
  if (record === undefined) return refuse('record-missing');
  if (record.kind !== 'work') return refuse('record-not-work');
  if (record.deletedAt !== null) return refuse('record-deleted');
  if (newParentId === null) return OK;
  if (newParentId === id) return refuse('parent-is-self');
  if (descendantsOf(index, id).some((descendant) => descendant.id === newParentId)) {
    return refuse('parent-is-descendant');
  }
  return parentVerdict(index, newParentId, subtreeHeight(index, id));
}

const REFUSAL_MESSAGES: Readonly<Record<HierarchyRefusal, string>> = Object.freeze({
  'record-missing': '该工作记录不存在。',
  'record-not-work': '只有工作记录可以参与任务层级，荣誉记录不能。',
  'record-deleted': '该任务在回收站中，请先恢复再调整层级。',
  'parent-missing': '所选的上级任务不存在。',
  'parent-not-work': '上级任务必须是工作记录，荣誉记录不能作为上级。',
  'parent-deleted': '所选的上级任务在回收站中，不能在其下添加或移入任务。',
  'parent-is-self': '任务不能作为自己的上级。',
  'parent-is-descendant': '不能把任务移到它自己的下级任务之下，这会形成循环。',
  'parent-chain-broken': '所选上级任务的层级关系已损坏，请先在「设置 → 诊断」中查看。',
  'too-deep': `任务层级最多 ${String(MAX_WORK_DEPTH)} 级，这样调整会超出层级上限。`,
});

export function describeHierarchyRefusal(reason: HierarchyRefusal): string {
  return REFUSAL_MESSAGES[reason];
}

/**
 * Raised by a repository when a hierarchy rule refuses a write.
 *
 * The message is the user-facing sentence, so the existing toast path shows something actionable.
 */
export class HierarchyError extends Error {
  override readonly name = 'HierarchyError';
  readonly reason:
    | HierarchyRefusal
    | 'has-live-descendants'
    | 'parent-in-trash'
    | 'has-descendants'
    | 'not-in-trash';

  constructor(reason: HierarchyError['reason'], message?: string) {
    super(message ?? (isRefusal(reason) ? describeHierarchyRefusal(reason) : reason));
    this.reason = reason;
  }
}

function isRefusal(reason: string): reason is HierarchyRefusal {
  return Object.hasOwn(REFUSAL_MESSAGES, reason);
}
