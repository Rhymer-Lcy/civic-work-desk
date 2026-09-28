import {
  HierarchyError,
  MAX_WORK_DEPTH,
  buildHierarchyIndex,
  canCreateUnder,
  canMove,
  parentIdOf,
} from '@/domain/hierarchy';
import type { AnyRecord, HonorRecord, WorkRecord } from '@/domain/types';
import { anyRecordSchema } from '@/domain/validation';
import { nowInstant } from '@/utils/clock';
import { withMutation } from '../client';
import type { CivicWorkDeskDatabase } from '../schema';

/**
 * Hierarchy operations: every write that changes where a work record sits in the tree, or that could
 * leave a descendant behind.
 *
 * **One rule for all of them:** the check and the write happen in the same read-write transaction over
 * `records`. IndexedDB serialises read-write transactions whose scopes overlap, so of two conflicting
 * operations — a child added under P while P is being moved to the trash, A moved under B while B is
 * moved under A — the second always sees what the first did and is refused. A check done in one
 * transaction and a write done in another would reopen exactly that window.
 *
 * **Only the neighbourhood is read.** Ancestors are fetched by id (at most `MAX_WORK_DEPTH` gets) and
 * descendants through the `parentWorkId` index, so a write costs a handful of reads whatever the size of
 * the archive. Rows are validated as they are read; a row that fails its schema is treated as absent, so
 * a corrupt parent refuses the write rather than being built upon.
 *
 * Policy (docs/phase-5-product-evolution.md §4.4 and §5): records are created and moved only under a
 * **live** parent; a record with live descendants is never moved to the trash on its own; a record whose
 * parent is in the trash is never restored on its own; nothing is purged while something still names it
 * as parent. Each multi-record operation is one transaction and bumps `dataRevision` once.
 */

type Db = CivicWorkDeskDatabase;

function parse(row: unknown): AnyRecord | null {
  const parsed = anyRecordSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

async function getValid(db: Db, id: string): Promise<AnyRecord | null> {
  const row = await db.records.get(id);
  return row === undefined ? null : parse(row);
}

/** `id` and its ancestors, nearest first; stops at a missing or invalid row or after the cap. */
async function fetchAncestry(db: Db, id: string): Promise<AnyRecord[]> {
  const out: AnyRecord[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null && !seen.has(current) && out.length <= MAX_WORK_DEPTH + 1) {
    seen.add(current);
    const record = await getValid(db, current);
    if (record === null) break;
    out.push(record);
    current = parentIdOf(record);
  }
  return out;
}

/** Every descendant of `id`, through the `parentWorkId` index, soft-deleted ones included. */
async function fetchDescendants(db: Db, id: string): Promise<AnyRecord[]> {
  const out: AnyRecord[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length > 0) {
    const rows = await db.records.where('parentWorkId').anyOf(frontier).toArray();
    frontier = [];
    for (const row of rows) {
      const record = parse(row);
      if (record === null || seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
      frontier.push(record.id);
    }
  }
  return out;
}

/** Throw the refusal as a `HierarchyError`, whose message is the user-facing sentence. */
function enforce(verdict: ReturnType<typeof canMove>): void {
  if (!verdict.ok) throw new HierarchyError(verdict.reason);
}

/**
 * Check, inside the caller's transaction, that a new work record may be created under `parentWorkId`.
 * Used by `createWorkRecord`; exported for it rather than duplicated.
 */
export async function assertCanCreateUnder(db: Db, parentWorkId: string | null): Promise<void> {
  if (parentWorkId === null) return;
  const index = buildHierarchyIndex(await fetchAncestry(db, parentWorkId));
  enforce(canCreateUnder(index, parentWorkId));
}

/** Move a work record — with its whole subtree — under `newParentId`, or to the top level with null. */
export async function moveWorkRecord(id: string, newParentId: string | null): Promise<WorkRecord> {
  return withMutation('moveWorkRecord', ['records'], async (db) => {
    const neighbourhood = [
      ...(await fetchAncestry(db, id)),
      ...(await fetchDescendants(db, id)),
      ...(newParentId === null ? [] : await fetchAncestry(db, newParentId)),
    ];
    const index = buildHierarchyIndex(neighbourhood);
    enforce(canMove(index, id, newParentId));
    const record = index.byId.get(id);
    if (record?.kind !== 'work') throw new HierarchyError('record-not-work');
    const moved: WorkRecord = { ...record, parentWorkId: newParentId, updatedAt: nowInstant() };
    await db.records.put(moved);
    return moved;
  });
}

/** How many live descendants `id` has, read inside the caller's transaction. */
async function liveDescendants(db: Db, id: string): Promise<AnyRecord[]> {
  return (await fetchDescendants(db, id)).filter((record) => record.deletedAt === null);
}

/**
 * Refuse, inside the caller's transaction, to trash a record that still has live descendants.
 * Used by `softDeleteRecord`, which keeps its own single-record semantics.
 */
export async function assertNoLiveDescendants(db: Db, id: string): Promise<void> {
  const live = await liveDescendants(db, id);
  if (live.length > 0) {
    throw new HierarchyError(
      'has-live-descendants',
      `该任务还有 ${String(live.length)} 项未删除的下级任务。请选择一并移入回收站，或先把下级任务移到其他位置。`,
    );
  }
}

/** Refuse, inside the caller's transaction, to restore a record whose parent is not live. */
export async function assertParentIsLive(db: Db, record: AnyRecord): Promise<void> {
  const parentId = parentIdOf(record);
  if (parentId === null) return;
  const parent = await getValid(db, parentId);
  if (parent === null) {
    throw new HierarchyError('parent-missing', '该任务的上级任务已不存在，无法恢复。');
  }
  if (parent.deletedAt !== null) {
    throw new HierarchyError(
      'parent-in-trash',
      `上级任务「${parent.title}」仍在回收站中。请先恢复上级任务，或连同上级一起恢复。`,
    );
  }
}

/** What a subtree operation touched. */
export interface SubtreeOutcome {
  /** The record the operation was invoked on. */
  readonly rootId: string;
  /** How many records changed, the root included. */
  readonly affected: number;
}

/**
 * Move a record and every **live** descendant to the trash with one shared `deletedAt` stamp.
 *
 * The shared stamp is what lets `restoreSubtree` undo exactly this operation later. Descendants that were
 * already in the trash keep their own, earlier stamp and are not part of this batch.
 */
export async function softDeleteSubtree(id: string): Promise<SubtreeOutcome> {
  return withMutation('softDeleteSubtree', ['records'], async (db) => {
    const root = await getValid(db, id);
    if (root === null) throw new HierarchyError('record-missing');
    if (root.deletedAt !== null) return { rootId: id, affected: 0 };
    const stamp = nowInstant();
    const batch = [root, ...(await liveDescendants(db, id))];
    for (const record of batch)
      await db.records.put({ ...record, deletedAt: stamp, updatedAt: stamp });
    return { rootId: id, affected: batch.length };
  });
}

/**
 * Promote a record's live children one level (to this record's own parent), then trash the record.
 *
 * Each child keeps its subtree, so every path gets one level shorter and the tree stays within the cap.
 * If this record's parent is itself in the trash — a state only an imported archive can produce — the
 * children become top-level tasks instead, because promoting them under a trashed parent would hide them.
 */
export async function softDeletePromotingChildren(id: string): Promise<SubtreeOutcome> {
  return withMutation('softDeletePromotingChildren', ['records'], async (db) => {
    const record = await getValid(db, id);
    if (record === null) throw new HierarchyError('record-missing');
    if (record.kind !== 'work') throw new HierarchyError('record-not-work');
    if (record.deletedAt !== null) return { rootId: id, affected: 0 };

    const grandparentId = parentIdOf(record);
    const grandparent = grandparentId === null ? null : await getValid(db, grandparentId);
    const promoteTo =
      grandparent !== null && grandparent.kind === 'work' && grandparent.deletedAt === null
        ? grandparent.id
        : null;

    const stamp = nowInstant();
    const children = (await db.records.where('parentWorkId').equals(id).toArray())
      .map(parse)
      .filter((child): child is WorkRecord => child?.kind === 'work' && child.deletedAt === null);
    for (const child of children) {
      const promoted: WorkRecord = { ...child, parentWorkId: promoteTo, updatedAt: stamp };
      await db.records.put(promoted);
    }
    await db.records.put({ ...record, deletedAt: stamp, updatedAt: stamp });
    return { rootId: id, affected: children.length + 1 };
  });
}

/**
 * Restore a record and the descendants that were trashed **with** it — the same `deletedAt` stamp —
 * walking down only through restored records, so nothing is revived beneath a record that stays in the
 * trash. The record's own parent must be live.
 */
export async function restoreSubtree(id: string): Promise<SubtreeOutcome> {
  return withMutation('restoreSubtree', ['records'], async (db) => {
    const root = await getValid(db, id);
    if (root === null) throw new HierarchyError('record-missing');
    if (root.deletedAt === null) return { rootId: id, affected: 0 };
    await assertParentIsLive(db, root);

    const batchStamp = root.deletedAt;
    const stamp = nowInstant();
    const restored: AnyRecord[] = [root];
    let frontier = [root.id];
    while (frontier.length > 0) {
      const rows = await db.records.where('parentWorkId').anyOf(frontier).toArray();
      frontier = [];
      for (const row of rows) {
        const child = parse(row);
        if (child?.deletedAt !== batchStamp) continue;
        restored.push(child);
        frontier.push(child.id);
      }
    }
    for (const record of restored) {
      await db.records.put({ ...record, deletedAt: null, updatedAt: stamp });
    }
    return { rootId: id, affected: restored.length };
  });
}

/** Descendants of `id` that share its `deletedAt` stamp — what `restoreSubtree` would bring back. */
export function sameBatchDescendants(
  records: readonly AnyRecord[],
  id: string,
): readonly AnyRecord[] {
  const index = buildHierarchyIndex(records);
  const batchStamp = index.byId.get(id)?.deletedAt ?? null;
  if (batchStamp === null) return [];
  const out: AnyRecord[] = [];
  let frontier = [id];
  const seen = new Set(frontier);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of index.children.get(parentId) ?? []) {
        if (seen.has(child.id) || child.deletedAt !== batchStamp) continue;
        seen.add(child.id);
        out.push(child);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return out;
}

/** Refuse, inside the caller's transaction, to purge a record that something still names as parent. */
export async function assertNothingNamesAsParent(db: Db, id: string): Promise<void> {
  const children = await db.records.where('parentWorkId').equals(id).count();
  if (children > 0) {
    throw new HierarchyError(
      'has-descendants',
      `该任务还有 ${String(children)} 项下级任务，不能单独彻底删除。请连同下级任务一起彻底删除。`,
    );
  }
}

/** What a subtree purge removed. */
export interface SubtreePurgeOutcome {
  readonly recordsPurged: number;
  readonly progressPurged: number;
  readonly honorsDetached: number;
}

/**
 * Permanently delete a trashed record together with every descendant.
 *
 * Refused unless every descendant is already in the trash: a purge must never take a live record with
 * it. Progress notes of every purged record are removed, and any honour linked to one of them keeps its
 * record and loses the link — the same rule a single purge applies, stated in the confirmation first.
 */
export async function purgeSubtree(id: string): Promise<SubtreePurgeOutcome> {
  return withMutation('purgeSubtree', ['records', 'progressEntries'], async (db) => {
    const root = await getValid(db, id);
    if (root === null) throw new HierarchyError('record-missing');
    if (root.deletedAt === null) {
      throw new HierarchyError('not-in-trash', '只能彻底删除回收站中的记录。');
    }
    const descendants = await fetchDescendants(db, id);
    const live = descendants.filter((record) => record.deletedAt === null);
    if (live.length > 0) {
      throw new HierarchyError(
        'has-live-descendants',
        `该任务有 ${String(live.length)} 项下级任务不在回收站中，不能一并彻底删除。`,
      );
    }
    const doomed = [root, ...descendants].map((record) => record.id);
    const doomedSet = new Set(doomed);

    let progressPurged = 0;
    for (const recordId of doomed) {
      progressPurged += await db.progressEntries.where('recordId').equals(recordId).count();
      await db.progressEntries.where('recordId').equals(recordId).delete();
    }

    const stamp = nowInstant();
    let honorsDetached = 0;
    for (const row of await db.records.toArray()) {
      if (row.kind !== 'honor' || doomedSet.has(row.id)) continue;
      if (row.relatedWorkId === null || !doomedSet.has(row.relatedWorkId)) continue;
      const detached: HonorRecord = { ...row, relatedWorkId: null, updatedAt: stamp };
      await db.records.put(detached);
      honorsDetached += 1;
    }

    await db.records.bulkDelete(doomed);
    return { recordsPurged: doomed.length, progressPurged, honorsDetached };
  });
}
