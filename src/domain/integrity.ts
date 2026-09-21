import type { AnyRecord, BusinessCategory, ProgressEntry, WorkGroup } from './types';

/**
 * Relational integrity of a complete application state.
 *
 * **One definition, used everywhere.** Phase 1.2 validated these rules only when a canonical archive
 * was about to be restored, which left the live database free to reach a state its own backups could
 * not restore: purging a work record from the Trash left any honour that referenced it pointing at a
 * row that no longer existed. Every row still passed its schema, the backup declared itself complete,
 * and the restore of that very file was refused for a dangling `relatedWorkId`.
 *
 * The rules therefore live in the domain layer, over plain arrays, with no knowledge of IndexedDB,
 * envelopes, React or the browser. The same function answers all of:
 *
 *   - may this canonical archive be restored exactly?
 *   - is the live database currently valid?
 *   - may a canonical backup of the live database be labelled complete?
 *   - would this merge leave the projected final state valid?
 *
 * Two deliberate choices about what is *not* a violation:
 *
 *   - **a soft-deleted record still satisfies a reference.** The row exists, it is carried in
 *     backups, and restoring it restores the relationship. Only permanent deletion breaks a link.
 *   - **a null reference is always valid.** `categoryId`, `groupId` and `relatedWorkId` are all
 *     optional by design; absence is a state, not damage.
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
  /** The offending entity's id, so it can be found in the store or in the file. */
  readonly id: string;
  /** The id that could not be resolved, for reference issues. */
  readonly reference?: string;
}

/**
 * A complete state to validate.
 *
 * "Complete" matters: these rules cannot be checked against a fragment. Validating a single record
 * against a partial view of the taxonomy would report a dangling reference that resolves perfectly
 * well in the whole state — which is exactly the mistake the merge planner used to make in the other
 * direction (see `projectFinalState`).
 */
export interface RelationalState {
  readonly records: readonly AnyRecord[];
  readonly progressEntries: readonly ProgressEntry[];
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
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
 * Every relational defect in the state, in a deterministic order.
 *
 * Returns all of them rather than stopping at the first: a user repairing a damaged archive needs the
 * whole list, and a preview that reveals one problem at a time misrepresents how bad the file is.
 */
export function validateRelationalIntegrity(state: RelationalState): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const { records, progressEntries, categories, groups } = state;

  for (const id of duplicates(records.map((record) => record.id))) {
    issues.push({ kind: 'duplicate-record-id', id });
  }
  for (const id of duplicates(progressEntries.map((entry) => entry.id))) {
    issues.push({ kind: 'duplicate-progress-id', id });
  }
  for (const id of duplicates(categories.map((category) => category.id))) {
    issues.push({ kind: 'duplicate-category-id', id });
  }
  for (const id of duplicates(groups.map((group) => group.id))) {
    issues.push({ kind: 'duplicate-group-id', id });
  }

  const recordIds = new Set(records.map((record) => record.id));
  const workIds = new Set(records.filter((record) => record.kind === 'work').map((r) => r.id));
  const categoryIds = new Set(categories.map((category) => category.id));
  const groupIds = new Set(groups.map((group) => group.id));

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
      // A related-work link must resolve to a *work* record; an honour pointing at another honour is
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

export function stateIsRelationallyValid(state: RelationalState): boolean {
  return validateRelationalIntegrity(state).length === 0;
}

const KIND_LABELS: Readonly<Record<IntegrityIssueKind, string>> = Object.freeze({
  'duplicate-record-id': '记录 ID 重复',
  'duplicate-progress-id': '进展 ID 重复',
  'duplicate-category-id': '业务分类 ID 重复',
  'duplicate-group-id': '归属分组 ID 重复',
  'orphan-progress': '进展找不到所属记录',
  'dangling-category': '记录引用了不存在的业务分类',
  'dangling-group': '记录引用了不存在的归属分组',
  'dangling-related-work': '荣誉引用了不存在的工作记录',
});

export function describeIntegrityKind(kind: IntegrityIssueKind): string {
  return KIND_LABELS[kind];
}

/**
 * One line per kind, with counts and a few example ids. Ordered for a stable preview.
 *
 * `context` names where the problem is, because the same wording now serves an archive ("不存在于文件中")
 * and the live database ("本机不存在").
 */
export function describeIntegrityIssues(
  issues: readonly IntegrityIssue[],
  context: 'file' | 'store' = 'file',
): string[] {
  const byKind = new Map<IntegrityIssueKind, IntegrityIssue[]>();
  for (const issue of issues) {
    const list = byKind.get(issue.kind) ?? [];
    list.push(issue);
    byKind.set(issue.kind, list);
  }
  const where = context === 'file' ? '文件中' : '本机';
  const lines: string[] = [];
  for (const kind of Object.keys(KIND_LABELS) as IntegrityIssueKind[]) {
    const group = byKind.get(kind);
    if (!group || group.length === 0) continue;
    const examples = group
      .slice(0, 3)
      .map((issue) => (issue.reference ? `${issue.id}→${issue.reference}` : issue.id))
      .join('、');
    const more = group.length > 3 ? ` 等 ${String(group.length)} 项` : '';
    const label = KIND_LABELS[kind].replace('不存在的', `${where}不存在的`);
    lines.push(`${label}：${examples}${more}`);
  }
  return lines;
}
