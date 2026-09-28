import type { WorkRecord } from '@/domain/types';
import {
  asString,
  residueText,
  resolveAudit,
  resolveDateField,
  resolveStatus,
  truncate,
} from './legacy-fields';
import type { BareWarning } from './legacy-fields';

/**
 * A legacy flat `subtasks[]` array, turned into level-2 work records.
 *
 * The friend-maintained successor of the prototype decomposed a task into a flat `subtasks[]` inside
 * the record. The Phase-4 importer did not know the field, and because `asString()` returns `''` for an
 * array, `collectResidue()` dropped it without a warning: every subtask in such a file was lost. Each
 * element now becomes an ordinary work record whose `parentWorkId` is the row it came from — a
 * 2级子任务 with its own status and deadlines, which a nested array could never have.
 *
 * **Mapping (first present key wins), and nothing invented beyond it:**
 *
 * | element key                              | becomes                                           |
 * | ---------------------------------------- | ------------------------------------------------- |
 * | `title`, `text`, `name`, `content`       | `title` — an element with none is dropped, warned |
 * | `date`                                   | `occurredOn`                                      |
 * | `deadline`                               | `reportDeadline` (the legacy meaning of `deadline`) |
 * | `due`                                    | `completionDeadline`                              |
 * | `done` boolean                           | 已完成 / 待办                                       |
 * | `done` or `status` string                | the legacy status table, with its warnings        |
 * | `doneTime`, `completedTime`              | `completedOn`                                     |
 * | `remark`, `note`                         | `remark`                                          |
 * | anything else                            | the sub-task's `legacyResidue`, warned            |
 *
 * Category, group and counterpart are **not** copied from the parent: the element did not state them.
 *
 * **Ids are deterministic** — `<parentId>::sub-<key>`, where `<key>` is the element's own `id` when it
 * has one and its 1-based position otherwise — so importing the same file twice yields conflicts, not a
 * second set of sub-tasks.
 *
 * **Caveat:** the field names come from the Phase-5 brief's description of that format; no file of it
 * was available, so this is verified against synthetic fixtures only (docs/phase-5-product-evolution.md
 * §7). `deadline → reportDeadline` follows the existing legacy mapping and is the choice to revisit when a
 * real sample, with personal data removed, exists.
 */

const TITLE_KEYS = ['title', 'text', 'name', 'content'] as const;
const KNOWN_SUBTASK_KEYS = new Set([
  'id',
  ...TITLE_KEYS,
  'date',
  'deadline',
  'due',
  'done',
  'status',
  'doneTime',
  'completedTime',
  'remark',
  'note',
  'createdAt',
]);

export interface LegacySubtaskOutcome {
  readonly records: readonly WorkRecord[];
  /** Warnings, each naming the sub-task it concerns in its `field`. */
  readonly warnings: readonly BareWarning[];
}

function firstText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const text = asString(source[key]).trim();
    if (text !== '') return text;
  }
  return '';
}

/** The element's own id, if it has a usable one. */
function ownKey(source: Record<string, unknown>): string | null {
  const raw = source['id'];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** Status from a boolean `done`, or from `done`/`status` wording through the legacy table. */
function subtaskStatus(
  source: Record<string, unknown>,
  field: string,
): { status: WorkRecord['status']; label: string; warnings: BareWarning[] } {
  const done = source['done'];
  if (typeof done === 'boolean') {
    return { status: done ? 'completed' : 'todo', label: '', warnings: [] };
  }
  const wording = done ?? source['status'];
  if (asString(wording) === '') return { status: 'todo', label: '', warnings: [] };
  const resolved = resolveStatus(wording);
  return {
    status: resolved.status,
    label: resolved.label,
    warnings: resolved.warnings.map((warning) => ({ ...warning, field })),
  };
}

/** Every key the mapping does not know, preserved losslessly. */
function subtaskResidue(source: Record<string, unknown>): Record<string, string> | null {
  const residue: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (KNOWN_SUBTASK_KEYS.has(key)) continue;
    const text = residueText(value);
    if (text.trim() !== '') residue[key] = text;
  }
  return Object.keys(residue).length > 0 ? residue : null;
}

/** One element, or null when it cannot become a record (the reason is pushed to `warnings`). */
function normaliseOne(
  element: unknown,
  position: number,
  parent: WorkRecord,
  stamp: string,
  warnings: BareWarning[],
): WorkRecord | null {
  const label = `subtasks[${String(position + 1)}]`;
  if (element === null || typeof element !== 'object' || Array.isArray(element)) {
    warnings.push({
      severity: 'warning',
      field: label,
      message: 'not an object; this sub-task was not imported',
      original: truncate(residueText(element)),
    });
    return null;
  }
  const source = element as Record<string, unknown>;
  const title = firstText(source, TITLE_KEYS);
  if (title === '') {
    warnings.push({
      severity: 'warning',
      field: label,
      message: 'no title; this sub-task was not imported',
      original: truncate(residueText(source)),
    });
    return null;
  }

  const at = (name: string): string => `${label}.${name}`;
  const occurredOn = resolveDateField(at('date'), '', source['date']);
  const reportDeadline = resolveDateField(at('deadline'), '', source['deadline']);
  const completionDeadline = resolveDateField(at('due'), '', source['due']);
  const completedOn = resolveDateField(
    at('doneTime'),
    '',
    source['doneTime'] ?? source['completedTime'],
  );
  for (const outcome of [occurredOn, reportDeadline, completionDeadline, completedOn]) {
    if (outcome.warning) warnings.push(outcome.warning);
  }
  const status = subtaskStatus(source, at('status'));
  warnings.push(...status.warnings);
  const residue = subtaskResidue(source);
  if (residue) {
    warnings.push({
      severity: 'warning',
      field: `${label}: ${Object.keys(residue).join(', ')}`,
      message: 'unrecognised sub-task field(s) preserved in legacyResidue',
      original: truncate(Object.values(residue).join(' | ')),
    });
  }

  return {
    ...resolveAudit(source['createdAt'], stamp),
    id: `${parent.id}::sub-${ownKey(source) ?? String(position + 1)}`,
    kind: 'work',
    parentWorkId: parent.id,
    title,
    occurredOn: occurredOn.value,
    status: status.status,
    statusLabel: status.label,
    requirement: '',
    reportDeadline: reportDeadline.value,
    completionDeadline: completionDeadline.value,
    completedOn: completedOn.value,
    categoryId: null,
    groupId: null,
    longTerm: false,
    counterpartUnit: '',
    counterpartContact: '',
    counterpartPhone: '',
    remark: asString(source['remark'] ?? source['note']),
    legacyResidue: residue,
  };
}

export function normaliseLegacySubtasks(
  raw: unknown,
  parent: WorkRecord,
  stamp: string,
): LegacySubtaskOutcome {
  if (raw === undefined || raw === null) return { records: [], warnings: [] };
  if (!Array.isArray(raw)) {
    return {
      records: [],
      warnings: [
        {
          severity: 'warning',
          field: 'subtasks',
          message: 'subtasks is not an array; kept in legacyResidue',
          original: truncate(residueText(raw)),
        },
      ],
    };
  }
  const warnings: BareWarning[] = [];
  const records: WorkRecord[] = [];
  raw.forEach((element: unknown, position) => {
    const record = normaliseOne(element, position, parent, stamp, warnings);
    if (record) records.push(record);
  });
  return { records, warnings };
}
