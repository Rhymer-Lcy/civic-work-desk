import { validateHierarchy } from '@/domain/hierarchy';
import type { IntegrityIssue } from '@/domain/integrity';
import type { AnyRecord, WorkRecord } from '@/domain/types';
import { anyRecordSchema, describeIssues } from '@/domain/validation';
import type { ImportStrategy } from './plan';

/**
 * The import planner's view of the work hierarchy (Phase 5), kept out of `plan.ts` so that module stays
 * about the order of placement rather than about tree rules.
 */

export interface HierarchyAssessment {
  /** Hierarchy defects in the state the write would leave behind. */
  readonly issues: readonly IntegrityIssue[];
  /** The destination alone already had hierarchy damage (merge only). */
  readonly destinationDamaged: boolean;
}

/**
 * Judge the hierarchy of the projected final state.
 *
 * A merge keeps the destination, so its tree is `destination + accepted`; a legacy replace clears the
 * destination, so its tree is `accepted` alone. A canonical restore is judged exactly — archive against
 * itself — by the relational validator, so nothing is added here for it.
 */
export function assessProjectedHierarchy(
  strategy: ImportStrategy,
  existing: readonly AnyRecord[],
  accepted: readonly AnyRecord[],
): HierarchyAssessment {
  if (strategy === 'canonical-restore') return { issues: [], destinationDamaged: false };
  const destination = strategy === 'merge' ? existing : [];
  return {
    issues: validateHierarchy([...destination, ...accepted]),
    destinationDamaged: strategy === 'merge' && validateHierarchy(existing).length > 0,
  };
}

export interface SubtaskPlacement {
  readonly subtasks: readonly WorkRecord[];
  /** The parent row will exist after the write: placed now, or already stored as the same record. */
  readonly parentWillExist: boolean;
  /** The parent row's id is taken in the destination by a record with different content. */
  readonly parentConflicted: boolean;
  readonly place: (record: AnyRecord) => void;
  readonly reject: (hint: string, reason: string) => void;
}

/**
 * Place the sub-tasks derived from a legacy row's flat `subtasks[]`.
 *
 * They are part of their row, like its progress notes: placed only when their parent will exist. A parent
 * skipped as an *identical* merge conflict is the same record imported again and still exists; a
 * different record that merely shares the id must not adopt sub-tasks that were never its own.
 */
export function placeLegacySubtasks(input: SubtaskPlacement): void {
  for (const subtask of input.subtasks) {
    if (!input.parentWillExist) {
      input.reject(
        subtask.title,
        input.parentConflicted
          ? '上级任务与本机同 ID 的记录内容不同，其子任务未导入'
          : '上级任务未能导入，其子任务一并未导入',
      );
      continue;
    }
    const checked = anyRecordSchema.safeParse(subtask);
    if (!checked.success) {
      input.reject(subtask.title, describeIssues(checked.error, 2).join('; '));
      continue;
    }
    input.place(checked.data);
  }
}
