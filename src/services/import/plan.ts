import { primaryDate } from '@/domain/types';
import type { AnyRecord, ProgressEntry } from '@/domain/types';
import { formatDateValue } from '@/domain/dates';
import { anyRecordSchema, describeIssues } from '@/domain/validation';
import { backupEnvelopeSchema, countsAreConsistent, verifyChecksum } from '../backup/envelope';
import type { BackupEnvelope, ChecksumVerdict } from '../backup/envelope';
import { isNormalisationFailure, normaliseLegacyRecord } from './legacy';
import type { MigrationWarning } from './legacy';

/**
 * The import pipeline: parse -> validate -> normalise -> preview -> confirm -> write.
 *
 * The legacy `importJSON()` collapsed all of that into one step. It parsed, then immediately
 * showed a native confirm whose only content was a row count, then merged. Three consequences:
 *   - no validation at all: `normalizeRecord()` coerced any object into a record, so a wrong file
 *     produced a store full of empty rows;
 *   - the duplicate check read a `Set` built before the loop and never updated inside it, so two
 *     rows sharing an id in the *same* file were both inserted, producing duplicate primary keys;
 *   - a record whose id already existed was dropped with no report — the user was told
 *     "已导入 N 条" where N silently excluded them.
 *
 * Nothing here writes. `buildImportPlan` is pure over its inputs; `applyImportPlan` (in
 * ./apply.ts) performs the single transactional write after explicit confirmation.
 */

export type SourceFormat =
  /** A CivicWorkDesk envelope. */
  | 'civic-envelope'
  /** Legacy `{version, exportTime, works}`. */
  | 'legacy-versioned'
  /** Legacy `{works, honors}` with a separate honours array. */
  | 'legacy-split'
  /** A bare array of legacy records. */
  | 'legacy-array';

export type ImportMode = 'merge' | 'replace';

export interface ImportConflict {
  readonly id: string;
  readonly incomingTitle: string;
  readonly existingTitle: string;
  readonly incomingDate: string;
  readonly existingDate: string;
  /** True when the two rows are byte-identical after normalisation. */
  readonly identical: boolean;
}

export interface ImportPlan {
  readonly format: SourceFormat;
  readonly mode: ImportMode;
  /** Records that will be written. */
  readonly accepted: readonly AnyRecord[];
  readonly acceptedProgress: readonly ProgressEntry[];
  /** Rows rejected outright, with a reason. */
  readonly rejected: readonly { readonly hint: string; readonly reason: string }[];
  /** Rows whose id already exists in the store. */
  readonly conflicts: readonly ImportConflict[];
  /** Ids appearing more than once inside the source file itself. */
  readonly duplicateIdsInSource: readonly string[];
  readonly warnings: readonly MigrationWarning[];
  /** Taxonomy and settings, present only for a CivicWorkDesk envelope. */
  readonly categories: BackupEnvelope['payload']['categories'] | null;
  readonly groups: BackupEnvelope['payload']['groups'] | null;
  readonly settings: BackupEnvelope['payload']['settings'] | null;
  readonly checksum: ChecksumVerdict | null;
  readonly countsConsistent: boolean | null;
  /** Counts for the preview. */
  readonly summary: ImportSummary;
}

export interface ImportSummary {
  readonly sourceRows: number;
  readonly acceptedWork: number;
  readonly acceptedHonors: number;
  readonly acceptedProgress: number;
  readonly rejected: number;
  readonly conflicts: number;
  readonly warnings: number;
  /** Conflicts that are byte-identical to what is already stored. */
  readonly identicalConflicts: number;
}

export class ImportParseError extends Error {
  override readonly name = 'ImportParseError';
  readonly details: readonly string[];
  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.details = details;
  }
}

interface DetectedSource {
  readonly format: SourceFormat;
  readonly rows: readonly unknown[];
  readonly envelope: BackupEnvelope | null;
}

/** Identify the shape of a parsed JSON document. Throws when nothing recognisable is found. */
export function detectSource(parsed: unknown): DetectedSource {
  if (Array.isArray(parsed)) {
    return { format: 'legacy-array', rows: parsed, envelope: null };
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ImportParseError('文件内容不是备份数据（既不是数组，也不是对象）。');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj['application'] === 'civic-work-desk') {
    const result = backupEnvelopeSchema.safeParse(obj);
    if (!result.success) {
      throw new ImportParseError(
        '这是 CivicWorkDesk 备份文件，但内容未通过校验，已拒绝导入。',
        describeIssues(result.error, 6),
      );
    }
    return { format: 'civic-envelope', rows: result.data.payload.records, envelope: result.data };
  }

  const works = obj['works'];
  const honors = obj['honors'];
  if (Array.isArray(works)) {
    const rows: unknown[] = Array.isArray(honors)
      ? [...(works as unknown[]), ...(honors as unknown[]).map(attachHonorCategory)]
      : (works as unknown[]);
    return {
      format: Array.isArray(honors) ? 'legacy-split' : 'legacy-versioned',
      rows,
      envelope: null,
    };
  }
  throw new ImportParseError('无法识别的备份格式：未找到 works 数组或 CivicWorkDesk 信封。');
}

/**
 * Mark a row from a legacy standalone `honors` array as an honour.
 * The legacy code did `Object.assign({category:'荣誉'}, h)`, which let the row's own `category`
 * win; the explicit spread order here makes the honour classification authoritative.
 */
function attachHonorCategory(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row;
  return { ...(row as Record<string, unknown>), category: '荣誉' };
}

/**
 * A stable signature of a record's *content*, ignoring audit timestamps.
 * Two records with the same signature are the same record however they were written.
 */
function recordSignature(record: AnyRecord): string {
  const rest: Record<string, unknown> = { ...record };
  delete rest['updatedAt'];
  delete rest['createdAt'];
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export interface BuildPlanInput {
  readonly parsed: unknown;
  readonly mode: ImportMode;
  readonly existing: readonly AnyRecord[];
}

/** Mutable working set shared by the two source-shape collectors. */
interface PlanAccumulator {
  readonly accepted: AnyRecord[];
  readonly acceptedProgress: ProgressEntry[];
  readonly rejected: { hint: string; reason: string }[];
  readonly conflicts: ImportConflict[];
  readonly warnings: MigrationWarning[];
  readonly seenInSource: Set<string>;
  readonly duplicateIdsInSource: string[];
}

function emptyAccumulator(): PlanAccumulator {
  return {
    accepted: [],
    acceptedProgress: [],
    rejected: [],
    conflicts: [],
    warnings: [],
    seenInSource: new Set<string>(),
    duplicateIdsInSource: [],
  };
}

/**
 * Classify one already-validated record against what is stored.
 * Returns false when the record was not accepted, so the caller can skip its progress entries.
 */
function placeRecord(
  record: AnyRecord,
  existingById: ReadonlyMap<string, AnyRecord>,
  acc: PlanAccumulator,
): boolean {
  if (acc.seenInSource.has(record.id)) {
    acc.duplicateIdsInSource.push(record.id);
    acc.rejected.push({ hint: record.title, reason: '同一文件内出现重复 ID' });
    return false;
  }
  acc.seenInSource.add(record.id);

  const clash = existingById.get(record.id);
  if (clash) {
    acc.conflicts.push(describeConflict(record, clash));
    return false;
  }
  acc.accepted.push(record);
  return true;
}

/** Records in a CivicWorkDesk envelope are already domain-shaped and schema-validated. */
function collectFromEnvelope(
  envelope: BackupEnvelope,
  existingById: ReadonlyMap<string, AnyRecord>,
  acc: PlanAccumulator,
): void {
  for (const record of envelope.payload.records) {
    placeRecord(record, existingById, acc);
  }
  const acceptedIds = new Set(acc.accepted.map((record) => record.id));
  for (const entry of envelope.payload.progressEntries) {
    if (acceptedIds.has(entry.recordId)) acc.acceptedProgress.push(entry);
  }
}

/** Legacy rows must be normalised and then validated before they can be placed. */
function collectFromLegacyRows(
  rows: readonly unknown[],
  existingById: ReadonlyMap<string, AnyRecord>,
  acc: PlanAccumulator,
): void {
  for (const [index, row] of rows.entries()) {
    const outcome = normaliseLegacyRecord(row, index);
    if (isNormalisationFailure(outcome)) {
      acc.rejected.push({ hint: outcome.hint, reason: outcome.reason });
      continue;
    }
    acc.warnings.push(...outcome.warnings);

    const validated = anyRecordSchema.safeParse(outcome.record);
    if (!validated.success) {
      acc.rejected.push({
        hint: outcome.record.title,
        reason: describeIssues(validated.error, 2).join('; '),
      });
      continue;
    }

    if (placeRecord(validated.data, existingById, acc)) {
      acc.acceptedProgress.push(...outcome.progress);
    }
  }
}

/** Build a full preview. Performs no writes and mutates nothing the caller owns. */
export async function buildImportPlan(input: BuildPlanInput): Promise<ImportPlan> {
  const { format, rows, envelope } = detectSource(input.parsed);
  const existingById = new Map(input.existing.map((record) => [record.id, record]));
  const acc = emptyAccumulator();

  if (format === 'civic-envelope' && envelope) {
    collectFromEnvelope(envelope, existingById, acc);
  } else {
    collectFromLegacyRows(rows, existingById, acc);
  }

  const { accepted, acceptedProgress, rejected, conflicts, warnings, duplicateIdsInSource } = acc;
  const checksum = envelope ? await verifyChecksum(envelope) : null;
  const identicalConflicts = conflicts.filter((c) => c.identical).length;

  return {
    format,
    mode: input.mode,
    accepted,
    acceptedProgress,
    rejected,
    conflicts,
    duplicateIdsInSource,
    warnings,
    categories: envelope?.payload.categories ?? null,
    groups: envelope?.payload.groups ?? null,
    settings: envelope?.payload.settings ?? null,
    checksum,
    countsConsistent: envelope ? countsAreConsistent(envelope) : null,
    summary: {
      sourceRows: rows.length,
      acceptedWork: accepted.filter((r) => r.kind === 'work').length,
      acceptedHonors: accepted.filter((r) => r.kind === 'honor').length,
      acceptedProgress: acceptedProgress.length,
      rejected: rejected.length,
      conflicts: conflicts.length,
      warnings: warnings.length,
      identicalConflicts,
    },
  };
}

function describeConflict(incoming: AnyRecord, existing: AnyRecord): ImportConflict {
  return {
    id: incoming.id,
    incomingTitle: incoming.title,
    existingTitle: existing.title,
    incomingDate: formatDateValue(primaryDate(incoming), '—'),
    existingDate: formatDateValue(primaryDate(existing), '—'),
    identical: recordSignature(incoming) === recordSignature(existing),
  };
}

/**
 * Conflict resolution policy, stated once so it is not re-decided per call site:
 *
 * **Merge never overwrites.** An incoming record whose id already exists is skipped and listed
 * in `conflicts`. This is deterministic and non-destructive: the stored row is the one the user
 * has been working with, and an import is not evidence that the file is newer. To adopt the
 * file's version, use replace mode — which requires a stronger confirmation and, in the UI, an
 * offer to back up first.
 *
 * **Replace destroys everything first.** `applyImportPlan` clears records and progress inside the
 * same transaction that writes the new set, so a failure rolls back to the previous state rather
 * than leaving a half-restored store.
 */
export const CONFLICT_POLICY = 'merge-skips-existing' as const;

/** Does this plan write anything at all? Used to disable the confirm button honestly. */
export function planWritesAnything(plan: ImportPlan): boolean {
  if (plan.mode === 'replace') return true;
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
  if (plan.mode === 'merge' && plan.accepted.length === 0 && plan.conflicts.length === 0) {
    blockers.push('没有任何可导入的记录。');
  }
  return blockers;
}
