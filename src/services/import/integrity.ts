import type { BackupEnvelope } from '../backup/envelope';

/**
 * Relational integrity of a canonical envelope.
 *
 * An exact restore promises that the database afterwards **equals** the archive. That promise is
 * only meaningful if the archive describes a coherent application state: a progress note whose
 * record is missing, a work record pointing at a category the file does not contain, or two rows
 * sharing a primary key cannot be restored without dropping, inventing or rewriting something.
 *
 * Phase 1.1 validated each row against its own schema and stopped there. Every check below passes
 * schema validation and still makes an exact restore impossible:
 *
 *   - a duplicate id: `bulkAdd` would reject the second row, or an upsert would silently keep one;
 *   - an orphan progress entry: restorable as a row, but it belongs to nothing and the next
 *     `purgeRecord` will never reach it;
 *   - a dangling `categoryId` / `groupId` / `relatedWorkId`: the restored record would display an
 *     association the database cannot resolve.
 *
 * The policy is to **refuse, never repair**. Silently dropping the orphan or nulling the dangling
 * reference would produce a database that does not match the file the user was told it restored.
 *
 * Legacy imports are explicitly out of scope: `legacy-replace` and merge of a legacy file use the
 * documented best-effort normalisation path, which is allowed to reject rows and report warnings.
 */

export type IntegrityIssueKind =
  | 'duplicate-record-id'
  | 'duplicate-progress-id'
  | 'duplicate-category-id'
  | 'duplicate-group-id'
  | 'orphan-progress'
  | 'dangling-category'
  | 'dangling-group'
  | 'dangling-related-work';

export interface IntegrityIssue {
  readonly kind: IntegrityIssueKind;
  /** The offending entity's id, so the user can find it in the file. */
  readonly id: string;
  /** The id that could not be resolved, for reference issues. */
  readonly reference?: string;
}

/** Ids that appear more than once, in first-seen order. */
function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    else seen.add(id);
  }
  return [...repeated];
}

/**
 * Every relational defect in the envelope, in a deterministic order.
 *
 * Returns everything rather than stopping at the first problem: a user fixing a damaged archive
 * needs the whole list, and a preview that reveals one defect at a time is a preview that lies
 * about how bad the file is.
 */
export function validateCanonicalIntegrity(envelope: BackupEnvelope): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const { records, progressEntries, categories, groups } = envelope.payload;

  for (const id of duplicates(records.map((r) => r.id))) {
    issues.push({ kind: 'duplicate-record-id', id });
  }
  for (const id of duplicates(progressEntries.map((p) => p.id))) {
    issues.push({ kind: 'duplicate-progress-id', id });
  }
  for (const id of duplicates(categories.map((c) => c.id))) {
    issues.push({ kind: 'duplicate-category-id', id });
  }
  for (const id of duplicates(groups.map((g) => g.id))) {
    issues.push({ kind: 'duplicate-group-id', id });
  }

  const recordIds = new Set(records.map((r) => r.id));
  const workIds = new Set(records.filter((r) => r.kind === 'work').map((r) => r.id));
  const categoryIds = new Set(categories.map((c) => c.id));
  const groupIds = new Set(groups.map((g) => g.id));

  for (const entry of progressEntries) {
    if (!recordIds.has(entry.recordId)) {
      issues.push({ kind: 'orphan-progress', id: entry.id, reference: entry.recordId });
    }
  }

  for (const record of records) {
    if (record.kind === 'work') {
      if (record.categoryId !== null && !categoryIds.has(record.categoryId)) {
        issues.push({ kind: 'dangling-category', id: record.id, reference: record.categoryId });
      }
      if (record.groupId !== null && !groupIds.has(record.groupId)) {
        issues.push({ kind: 'dangling-group', id: record.id, reference: record.groupId });
      }
    } else if (record.relatedWorkId !== null && !workIds.has(record.relatedWorkId)) {
      // A related-work link must point at a *work* record; an honour pointing at another honour is
      // as broken as one pointing at nothing.
      issues.push({
        kind: 'dangling-related-work',
        id: record.id,
        reference: record.relatedWorkId,
      });
    }
  }

  return issues;
}

const KIND_LABELS: Readonly<Record<IntegrityIssueKind, string>> = Object.freeze({
  'duplicate-record-id': '记录 ID 重复',
  'duplicate-progress-id': '进展 ID 重复',
  'duplicate-category-id': '业务分类 ID 重复',
  'duplicate-group-id': '归属分组 ID 重复',
  'orphan-progress': '进展找不到所属记录',
  'dangling-category': '记录引用了文件中不存在的业务分类',
  'dangling-group': '记录引用了文件中不存在的归属分组',
  'dangling-related-work': '荣誉引用了文件中不存在的工作记录',
});

/** One line per kind, with counts and a few example ids. Ordered for a stable preview. */
export function describeIntegrityIssues(issues: readonly IntegrityIssue[]): string[] {
  const byKind = new Map<IntegrityIssueKind, IntegrityIssue[]>();
  for (const issue of issues) {
    const list = byKind.get(issue.kind) ?? [];
    list.push(issue);
    byKind.set(issue.kind, list);
  }
  const lines: string[] = [];
  for (const [kind, label] of Object.entries(KIND_LABELS) as [IntegrityIssueKind, string][]) {
    const group = byKind.get(kind);
    if (!group || group.length === 0) continue;
    const examples = group
      .slice(0, 3)
      .map((issue) => (issue.reference ? `${issue.id}→${issue.reference}` : issue.id))
      .join('、');
    const more = group.length > 3 ? ` 等 ${String(group.length)} 项` : '';
    lines.push(`${label}：${examples}${more}`);
  }
  return lines;
}
