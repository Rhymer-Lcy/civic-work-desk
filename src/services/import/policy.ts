import { describeIntegrityIssues } from '@/domain/integrity';
import type { BackupCompleteness } from '../backup/compatibility';
import { envelopeIsVerifiedComplete } from '../backup/envelope';
import type { BackupEnvelope } from '../backup/envelope';
import { isReplaceStrategy } from './plan';
import type { ImportPlan } from './plan';

/**
 * Import policy: what a plan is allowed to do, and what refuses it.
 *
 * Split out of `plan.ts` in Phase 1.3 when that module outgrew its line budget. The division is by
 * responsibility rather than by convenience: `plan.ts` decides *what an import would do*, and this
 * module decides *whether it may*. Everything here is a pure function of a finished plan, which is
 * what lets the preview, the confirm button and `applyImportPlan` all reach the same verdict from the
 * same input — the property Phase 1 lacked when the preview and the write disagreed.
 */

/**
 * Resolution policy, stated once so it is not re-decided per call site.
 *
 * **Merge never overwrites.** An incoming record whose id already exists is skipped and listed in
 * `conflicts`; an incoming progress entry whose id already exists is skipped and listed in
 * `progressCollisions`. Deterministic and non-destructive: the stored row is the one the user has
 * been working with, and an import is not evidence that the file is newer.
 *
 * **Canonical restore is exact.** A CivicWorkDesk envelope is the source of truth: records,
 * progress, categories, groups and settings are replaced wholesale inside one transaction.
 * Destination ids are irrelevant — that is the entire point of a restore, and treating them as
 * conflicts is what made Phase 1 clear the database and restore nothing.
 *
 * **Legacy replace is narrower, and says so.** A legacy file carries no taxonomy and no settings,
 * so it replaces records and progress only and leaves the rest of the application alone. The
 * preview must not describe it as 完整还原.
 */
export const RESOLUTION_POLICY = Object.freeze({
  merge: 'skips-existing',
  'canonical-restore': 'replaces-all-restoreable-state',
  'legacy-replace': 'replaces-records-and-progress-only',
});

/** Does this plan write anything at all? Used to disable the confirm button honestly. */
export function planWritesAnything(plan: ImportPlan): boolean {
  if (isReplaceStrategy(plan.strategy)) return true;
  return plan.accepted.length > 0 || plan.acceptedProgress.length > 0;
}

/** Blocking problems. A plan with any of these must not be applied. */
export function planBlockers(plan: ImportPlan): string[] {
  const blockers: string[] = [];
  if (plan.checksum === 'mismatch') {
    blockers.push('校验和不匹配：文件内容与其自带的校验值不一致，可能已损坏或被改动。');
  }
  if (plan.countsConsistent === false) {
    blockers.push('信封声明的记录条数与实际内容不一致。');
  }
  /*
   * A canonical restore promises the database will equal the backup. A file that repeats a record
   * id cannot deliver that — one of the two rows must be dropped — so the restore is refused
   * rather than silently producing a database that does not match the archive.
   *
   * Merge and legacy-replace keep the Phase-1 behaviour: reject the duplicate row, report it,
   * proceed. Legacy exports are messy by nature and neither mode claims exactness.
   */
  if (plan.strategy === 'canonical-restore' && plan.duplicateIdsInSource.length > 0) {
    blockers.push(
      `备份文件内部有 ${String(plan.duplicateIdsInSource.length)} 个重复的记录 ID，` +
        `无法按“完整还原”精确还原，已拒绝。`,
    );
  }

  /*
   * The same argument for progress entries. Phase 1.1 detected the duplicate, dropped the second
   * row and continued — the restore then silently contained fewer notes than the archive while
   * still being presented as exact.
   */
  if (plan.strategy === 'canonical-restore' && plan.duplicateProgressIdsInSource.length > 0) {
    blockers.push(
      `备份文件内部有 ${String(plan.duplicateProgressIdsInSource.length)} 个重复的进展 ID，` +
        '“完整还原”必须逐条写回，无法丢弃其中一条，已拒绝。',
    );
  }

  /*
   * An archive that declares itself incomplete cannot reproduce the original database, so it must
   * never be used as an exact restore source — whatever the user confirmed. Merge remains
   * available: adding rows the destination lacks is meaningful even from a partial file.
   *
   * `unknown-legacy` (a v1 archive) is deliberately NOT blocked. Its completeness is unknown, not
   * known-bad, and refusing it would strand anyone whose only backup predates the field. It is
   * gated on an explicitly worded confirmation instead — see `requiresCompletenessAcknowledgement`.
   */
  if (plan.strategy === 'canonical-restore' && plan.completeness === 'incomplete') {
    blockers.push(
      '该备份自述省略了未通过校验的数据行（omittedInvalidRowIds 非空），' +
        '无法用于“完整还原”：还原后的数据库不会等同于原数据库。' +
        '请改用“合并”导入，或选择一份完整备份；损坏行请用诊断恢复文件处理。',
    );
  }

  if (plan.strategy === 'canonical-restore' && plan.integrityIssues.length > 0) {
    blockers.push(
      `备份文件的关联关系不自洽，无法精确还原（${String(plan.integrityIssues.length)} 处）：` +
        describeIntegrityIssues(plan.integrityIssues).join('；'),
    );
  }

  if (plan.strategy === 'merge' && plan.accepted.length === 0 && plan.conflicts.length === 0) {
    blockers.push('没有任何可导入的记录。');
  }

  /*
   * A destructive replace must actually replace something.
   *
   * A legacy file whose every row is unimportable contributes no records, so proceeding would clear
   * the database and write nothing — import as a disguised wipe. The user has a dedicated, separately
   * confirmed destructive workflow in Settings for that intent; an import dialog must not become a
   * second one by accident.
   *
   * A canonical restore is deliberately NOT subject to this: a verified-complete backup of an empty
   * database is a legitimate archive, and restoring it is a real operation with a real meaning.
   */
  if (plan.strategy === 'legacy-replace' && plan.accepted.length === 0) {
    blockers.push(
      '该文件没有任何可导入的记录，无法用于“替换”。' +
        '否则这次导入只会清空本机数据而不写入任何内容。' +
        '如果确实要清空数据，请使用「设置 → 清空全部本机数据」。',
    );
  }

  /*
   * A merge that cannot write an accepted row without breaking a reference is reported, never
   * silently repaired — see `referenceRejections` on the plan for the per-row reasons.
   */
  return blockers;
}

/**
 * The completeness classification, for callers that want the envelope's own verdict.
 *
 * Kept next to the plan so "is this file a valid exact-restore source?" has exactly one answer in
 * the codebase.
 */
export function envelopeCompleteness(envelope: BackupEnvelope): {
  readonly completeness: BackupCompleteness;
  readonly verifiedComplete: boolean;
} {
  return {
    completeness: envelope.completeness,
    verifiedComplete: envelopeIsVerifiedComplete(envelope),
  };
}
