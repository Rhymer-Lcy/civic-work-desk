import type { AnyRecord, ProgressEntry } from '@/domain/types';
import { newId, nowInstant } from '@/utils/clock';
import {
  asString,
  buildHonor,
  buildWork,
  collectResidue,
  looksLikeHonor,
  normaliseProgress,
  resolveAudit,
  resolveDateField,
  truncate,
} from './legacy-fields';
import type { NormaliseOptions } from './legacy-fields';

/**
 * Legacy record normalisation.
 *
 * Accepts a record shaped like anything the prototype ever wrote, and produces a domain record
 * plus a list of warnings. The guiding rule: **never discard, never guess silently.** Any value
 * that cannot be mapped losslessly is preserved — as a `text` date, as `statusLabel`, or in
 * `legacyResidue` — and a warning names the field so a human can adjudicate it in the preview.
 *
 * The legacy shapes handled here (all observed in the prototype's own code):
 *   - the current record shape: `{id, category, date, title, requirement, deadlineType,
 *     deadline, dueType, due, done, doneTime, unit, contact, phone, remark, longterm,
 *     progress, hType, hLevel, hNo, hRole, hEvidence, hRelated, fixedGroup, biz}`
 *   - the pre-merge honour shape that `normalizeRecord()` still upgraded:
 *     `{name, type, level, from, no, role, evidence, related}`
 *   - progress entries as an array of loosely-typed objects on the record.
 */

export type WarningSeverity = 'info' | 'warning';

export interface MigrationWarning {
  readonly severity: WarningSeverity;
  /** Index in the source array, for "row 42" messaging. */
  readonly sourceIndex: number;
  readonly recordTitle: string;
  readonly field: string;
  readonly message: string;
  /** The original value, truncated. Never a full free-text body. */
  readonly original: string;
}

export interface NormalisedRecord {
  readonly record: AnyRecord;
  readonly progress: readonly ProgressEntry[];
  readonly warnings: readonly MigrationWarning[];
}

export interface NormalisationFailure {
  readonly sourceIndex: number;
  readonly reason: string;
  /** A short, non-sensitive description so the preview can identify the row. */
  readonly hint: string;
}

/**
 * Normalise one legacy row.
 * Returns a failure only when the row carries no usable title, since a record with no subject
 * cannot be meaningfully filed or found again.
 */
export function normaliseLegacyRecord(
  input: unknown,
  sourceIndex: number,
  options: NormaliseOptions = {},
): NormalisedRecord | NormalisationFailure {
  const preserveIds = options.preserveIds ?? true;
  const inferCategories = options.inferCategories ?? true;

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { sourceIndex, reason: 'not an object', hint: `row ${sourceIndex + 1}` };
  }
  const source = input as Record<string, unknown>;
  const title = (asString(source['title']) || asString(source['name'])).trim();
  if (title === '') {
    return { sourceIndex, reason: 'no title', hint: `row ${sourceIndex + 1}` };
  }

  const stamp = nowInstant();
  const legacyId = asString(source['id']).trim();
  const id = preserveIds && legacyId !== '' ? legacyId : newId();
  const warnings: MigrationWarning[] = [];
  const push = (w: Omit<MigrationWarning, 'sourceIndex' | 'recordTitle'>): void => {
    warnings.push({ ...w, sourceIndex, recordTitle: truncate(title, 30) });
  };

  const residue = collectResidue(source);
  if (residue) {
    push({
      severity: 'warning',
      field: Object.keys(residue).join(', '),
      message: 'unrecognised field(s) preserved in legacyResidue',
      original: truncate(Object.values(residue).join(' | ')),
    });
  }

  const dateField = resolveDateField('date', source['date'] ? 'date' : '', source['date']);
  if (dateField.warning) push(dateField.warning);

  const { entries: progress, dropped } = normaliseProgress(source['progress'], id, stamp);
  if (dropped > 0) {
    push({
      severity: 'warning',
      field: 'progress',
      message: `${dropped} progress entr${dropped === 1 ? 'y' : 'ies'} had no text and were not imported`,
      original: '',
    });
  }

  const audit = resolveAudit(source['createdAt'], stamp);

  if (looksLikeHonor(source)) {
    const honor = buildHonor({ source, audit, id, title, awardedOn: dateField.value, residue });
    return { record: honor, progress, warnings };
  }

  const work = buildWork({
    source,
    audit,
    id,
    title,
    occurredOn: dateField.value,
    residue,
    inferCategories,
  });
  work.warnings.forEach(push);
  return { record: work.record, progress, warnings };
}

export function isNormalisationFailure(
  value: NormalisedRecord | NormalisationFailure,
): value is NormalisationFailure {
  return 'reason' in value;
}
