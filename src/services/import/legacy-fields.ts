import { ABSENT_DATE, parseLegacyDate } from '@/domain/dates';
import type { DateValue } from '@/domain/dates';
import { categoryIdByLegacyName, guessCategoryId, groupIdByLegacyName } from '@/domain/defaults';
import { mapLegacyStatus } from '@/domain/status';
import type { WorkStatus } from '@/domain/status';
import type { HonorRecord, ProgressEntry, WorkRecord } from '@/domain/types';
import { newId } from '@/utils/clock';
import type { MigrationWarning, WarningSeverity } from './legacy';

/**
 * Field-level normalisation helpers for the legacy importer.
 *
 * Split out of `legacy.ts` so that file stays an orchestrator: read a row, resolve each field,
 * assemble a record. Each function here owns exactly one legacy quirk and returns both the value
 * and any warning that must reach the import preview.
 */

/** Fields the normaliser understands. Anything else on a source row lands in `legacyResidue`. */
const KNOWN_FIELDS = new Set([
  'id',
  'category',
  'date',
  'title',
  'name',
  'requirement',
  'require',
  'deadlineType',
  'deadline',
  'dueType',
  'due',
  'done',
  'doneTime',
  'completedTime',
  'unit',
  'from',
  'contact',
  'peer',
  'phone',
  'remark',
  'note',
  'longterm',
  'progress',
  'hType',
  'type',
  'hLevel',
  'level',
  'hNo',
  'no',
  'hRole',
  'role',
  'hEvidence',
  'evidence',
  'hRelated',
  'related',
  'fixedGroup',
  'biz',
  'createdAt',
  'status',
  'time',
]);

/** A warning before the row context (index, title) is attached by the orchestrator. */
export type BareWarning = Omit<MigrationWarning, 'sourceIndex' | 'recordTitle'>;

export interface AuditStamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: null;
}

export interface HonorBuildInput {
  readonly source: Record<string, unknown>;
  readonly audit: AuditStamps;
  readonly id: string;
  readonly title: string;
  readonly awardedOn: DateValue;
  readonly residue: Record<string, string> | null;
}

export interface DateFieldOutcome {
  readonly value: DateValue;
  readonly warning: BareWarning | null;
}

export function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function truncate(value: string, max = 60): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * A phone/contact value is a string, always.
 *
 * Real data contains `82393933.0`, `82496017.0` and `82469820.0` — landline numbers that passed
 * through a spreadsheet as floats — plus `656430\n673679` (two numbers in one cell), `X\n136...`
 * and `0579-83118218`. None of these is rewritten. The `.0` case is *reported* rather than
 * stripped, because "trailing `.0` is an Excel artefact" is an inference, and a silent edit to a
 * contact number is exactly the kind of change nobody notices until they dial it.
 */
export function inspectPhone(raw: unknown): { value: string; suspicion: string | null } {
  const value = asString(raw);
  if (value.trim() === '') return { value, suspicion: null };
  if (/^\d+\.0+$/.test(value.trim())) {
    return {
      value,
      suspicion: 'looks like a spreadsheet-derived number (trailing ".0"); left unchanged',
    };
  }
  if (typeof raw === 'number') {
    return { value, suspicion: 'arrived as a number; stored as text, leading zeroes may be lost' };
  }
  if (/[\r\n]/.test(value)) {
    return { value, suspicion: 'contains more than one line; may hold several numbers' };
  }
  return { value, suspicion: null };
}

/**
 * Resolve a legacy date pair (`xType` + `x`).
 *
 * The prototype's `xType` discriminator was unreliable: `normalizeRecord()` defaulted `dueType`
 * to `'none'` when absent, but the embedded data contains `"dueType": ""` with a populated
 * `due`, and rows with `deadlineType: "date"` whose `deadline` is free text. So the *value* is
 * parsed on its own merits and `xType` is used only as a cross-check.
 */
export function resolveDateField(
  field: string,
  declaredType: unknown,
  rawValue: unknown,
): DateFieldOutcome {
  const parsed = parseLegacyDate(rawValue);
  const raw = asString(rawValue);
  const declared = asString(declaredType);

  if (parsed.value.kind === 'text') {
    const reason =
      parsed.reason === 'year-missing'
        ? 'a day/month without a year; kept as text so no year is invented'
        : parsed.reason === 'impossible-calendar-date'
          ? 'not a real calendar date; kept as text rather than shifted'
          : 'not recognisable as a date; kept as text';
    // `declared === 'text'` means the author intended free text, which is not a defect.
    const severity: WarningSeverity = declared === 'text' ? 'info' : 'warning';
    return {
      value: parsed.value,
      warning: { severity, field, message: reason, original: truncate(raw) },
    };
  }

  if (parsed.normalised === true) {
    return {
      value: parsed.value,
      warning: {
        severity: 'info',
        field,
        message: 'rewritten into canonical YYYY-MM-DD form',
        original: truncate(raw),
      },
    };
  }

  return { value: parsed.value, warning: null };
}

export function collectResidue(source: Record<string, unknown>): Record<string, string> | null {
  const residue: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (KNOWN_FIELDS.has(key)) continue;
    const text = asString(value);
    if (text.trim() !== '') residue[key] = text;
  }
  return Object.keys(residue).length > 0 ? residue : null;
}

export function normaliseProgress(
  raw: unknown,
  recordId: string,
  stamp: string,
): { entries: ProgressEntry[]; dropped: number } {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0 };
  const entries: ProgressEntry[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim() === '') {
        dropped += 1;
        continue;
      }
      entries.push({
        id: newId(),
        recordId,
        occurredOn: ABSENT_DATE,
        note: item,
        createdAt: stamp,
        updatedAt: stamp,
      });
      continue;
    }
    if (item === null || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    const obj = item as Record<string, unknown>;
    const note = asString(obj['content'] ?? obj['text'] ?? obj['note'] ?? obj['desc']);
    if (note.trim() === '') {
      dropped += 1;
      continue;
    }
    const when = parseLegacyDate(obj['date'] ?? obj['time'] ?? obj['at']);
    entries.push({
      id: newId(),
      recordId,
      occurredOn: when.value,
      note,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  return { entries, dropped };
}

/** True when a legacy row should become an honour record. */
export function looksLikeHonor(source: Record<string, unknown>): boolean {
  if (asString(source['category']).trim() === '荣誉') return true;
  // The oldest honour shape had `name` instead of `title`, which is how `normalizeRecord()`
  // detected it. Preserved so an old standalone honour backup still migrates.
  if (asString(source['name']).trim() !== '' && asString(source['title']).trim() === '')
    return true;
  return false;
}

export interface NormaliseOptions {
  /** Preserve legacy ids so re-importing the same backup is idempotent. Default true. */
  readonly preserveIds?: boolean;
  /** Apply the keyword category guesser to work rows that have no category. Default true. */
  readonly inferCategories?: boolean;
}

/** Map the legacy `done` value, reporting how confident the mapping is. */
export function resolveStatus(raw: unknown): {
  status: WorkStatus;
  label: string;
  warnings: BareWarning[];
} {
  const label = asString(raw);
  const mapped = mapLegacyStatus(raw);
  if (mapped === null) {
    return {
      status: 'todo',
      label,
      warnings: [
        {
          severity: 'warning',
          field: 'status',
          message:
            'unrecognised completion wording; filed as 待办 and the original kept in statusLabel',
          original: truncate(label),
        },
      ],
    };
  }
  if (mapped.inferred) {
    return {
      status: mapped.status,
      label,
      warnings: [
        {
          severity: 'info',
          field: 'status',
          message: 'completion wording matched by prefix only',
          original: truncate(label),
        },
      ],
    };
  }
  return { status: mapped.status, label, warnings: [] };
}

/**
 * Map a legacy category name onto a stable id.
 *
 * An unknown name is never adopted — a typo would create a permanent phantom category. The row is
 * left uncategorised, warned about, and then offered to the keyword classifier.
 */
export function resolveCategory(
  legacyName: string,
  title: string,
  inferCategories: boolean,
): { categoryId: string | null; warnings: BareWarning[] } {
  const warnings: BareWarning[] = [];
  let categoryId = categoryIdByLegacyName(legacyName);
  if (categoryId === null && legacyName.trim() !== '') {
    warnings.push({
      severity: 'warning',
      field: 'categoryId',
      message: 'category name is not one of the built-in categories; left uncategorised',
      original: truncate(legacyName, 30),
    });
  }
  if (categoryId === null && inferCategories) categoryId = guessCategoryId(title);
  return { categoryId, warnings };
}

/** Map a legacy group name onto a stable id, warning when the name is unknown. */
export function resolveGroup(legacyName: string): {
  groupId: string | null;
  warnings: BareWarning[];
} {
  const groupId = groupIdByLegacyName(legacyName);
  if (groupId === null && legacyName.trim() !== '') {
    return {
      groupId,
      warnings: [
        {
          severity: 'warning',
          field: 'groupId',
          message: 'group name is not one of the built-in groups; left ungrouped',
          original: truncate(legacyName, 30),
        },
      ],
    };
  }
  return { groupId, warnings: [] };
}

/**
 * Adopt the legacy `createdAt` only when it is usable.
 *
 * It was `new Date(r.date).getTime()`, i.e. NaN for a free-text date and a UTC-shifted instant
 * otherwise, so it is not trustworthy as an audit timestamp.
 */
export function resolveAudit(
  raw: unknown,
  stamp: string,
): { createdAt: string; updatedAt: string; deletedAt: null } {
  const usable = typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
  return {
    createdAt: usable ? new Date(raw).toISOString() : stamp,
    updatedAt: stamp,
    deletedAt: null,
  };
}

/**
 * Assemble an honour record.
 *
 * Each field accepts both the current key and the oldest key, because `normalizeRecord()` in the
 * prototype still upgraded that older shape (`name`/`type`/`level`/`from`/`no`/`role`/`evidence`)
 * and standalone honour backups in that form may still exist.
 */
export function buildHonor(input: HonorBuildInput): HonorRecord {
  const { source, audit, id, title, awardedOn, residue } = input;
  const pick = (current: string, legacy: string): string =>
    asString(source[current] ?? source[legacy]);
  return {
    ...audit,
    id,
    kind: 'honor',
    title,
    awardedOn,
    honorType: pick('hType', 'type'),
    level: pick('hLevel', 'level'),
    issuingOrg: pick('unit', 'from'),
    documentNo: pick('hNo', 'no'),
    personalRole: pick('hRole', 'role'),
    evidenceLocation: pick('hEvidence', 'evidence'),
    relatedWorkId: pick('hRelated', 'related').trim() || null,
    remark: pick('remark', 'note'),
    legacyResidue: residue,
  };
}

export interface WorkBuildInput {
  readonly source: Record<string, unknown>;
  readonly audit: AuditStamps;
  readonly id: string;
  readonly title: string;
  readonly occurredOn: DateValue;
  readonly residue: Record<string, string> | null;
  readonly inferCategories: boolean;
}

/**
 * Assemble a work record, resolving each field that can disagree with the legacy schema and
 * collecting the warnings those resolutions produce.
 *
 * Deliberately one function rather than inline in the orchestrator: every branch here exists
 * because some real row in the prototype's data contradicted its own declared shape, and keeping
 * them together makes the set of known quirks readable as a list.
 */
export function buildWork(input: WorkBuildInput): {
  record: WorkRecord;
  warnings: BareWarning[];
} {
  const { source, audit, id, title, occurredOn, residue, inferCategories } = input;
  const warnings: BareWarning[] = [];

  const reportDeadline = resolveDateField(
    'reportDeadline',
    source['deadlineType'],
    source['deadline'],
  );
  if (reportDeadline.warning) warnings.push(reportDeadline.warning);

  const completionDeadline = resolveDateField(
    'completionDeadline',
    source['dueType'],
    source['due'],
  );
  if (completionDeadline.warning) warnings.push(completionDeadline.warning);

  const completedOn = resolveDateField(
    'completedOn',
    '',
    source['doneTime'] ?? source['completedTime'],
  );
  if (completedOn.warning) warnings.push(completedOn.warning);

  const status = resolveStatus(source['done']);
  warnings.push(...status.warnings);

  const phone = inspectPhone(source['phone']);
  if (phone.suspicion) {
    warnings.push({
      severity: 'warning',
      field: 'counterpartPhone',
      message: phone.suspicion,
      original: truncate(phone.value, 30),
    });
  }

  const category = resolveCategory(asString(source['biz']), title, inferCategories);
  warnings.push(...category.warnings);

  const group = resolveGroup(asString(source['fixedGroup']));
  warnings.push(...group.warnings);

  const record: WorkRecord = {
    ...audit,
    id,
    kind: 'work',
    title,
    occurredOn,
    status: status.status,
    statusLabel: status.label,
    requirement: asString(source['requirement'] ?? source['require']),
    reportDeadline: reportDeadline.value,
    completionDeadline: completionDeadline.value,
    completedOn: completedOn.value,
    categoryId: category.categoryId,
    groupId: group.groupId,
    longTerm: source['longterm'] === true,
    counterpartUnit: asString(source['unit']),
    counterpartContact: asString(source['contact'] ?? source['peer']),
    counterpartPhone: phone.value,
    remark: asString(source['remark'] ?? source['note']),
    legacyResidue: residue,
  };
  return { record, warnings };
}
