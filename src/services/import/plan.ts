import { primaryDate } from '@/domain/types';
import type { AnyRecord, ProgressEntry } from '@/domain/types';
import { formatDateValue } from '@/domain/dates';
import { anyRecordSchema, describeIssues } from '@/domain/validation';
import {
  canonicalJson,
  countsAreConsistent,
  envelopeIsVerifiedComplete,
  verifyChecksum,
} from '../backup/envelope';
import type { BackupCompleteness, ChecksumScope } from '../backup/compatibility';
import { detectSource } from './detect';
import type { SourceFormat } from './detect';
import type { BackupEnvelope, ChecksumVerdict } from '../backup/envelope';
import { describeIntegrityIssues, validateCanonicalIntegrity } from './integrity';
import type { IntegrityIssue } from './integrity';
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

/*
 * Source detection lives in ./detect.ts since Phase 1.2, when this module outgrew its line
 * budget. Re-exported here so `detectSource`, `ImportParseError` and `SourceFormat` keep their
 * existing import path: the split is internal organisation, not an API change.
 */
export { ImportParseError } from './detect';
export type { DetectedSource, SourceFormat } from './detect';
export { detectSource };

export type ImportMode = 'merge' | 'replace';

/**
 * What an import actually does, resolved from the user's intent and the file's capability.
 *
 * Phase 1 had only `mode`, and `buildImportPlan()` never consulted it: destination ids were
 * treated as conflicts in *every* mode, so restoring a backup of the current database excluded
 * every row and `applyImportPlan()` then cleared the store and wrote nothing. Making the
 * strategy explicit is the fix — each one has its own, separately tested, rules.
 */
export type ImportStrategy =
  /** Destination state matters. Nothing existing is ever overwritten. */
  | 'merge'
  /** A CivicWorkDesk envelope is the source of truth. Restoreable state is replaced wholesale. */
  | 'canonical-restore'
  /** A legacy file replaces records and progress only; it carries no taxonomy or settings. */
  | 'legacy-replace';

/**
 * Resolve the strategy.
 *
 * Only a canonical envelope can perform a whole-application restore, because only it carries
 * categories, groups and settings. A legacy file in replace mode gets `legacy-replace`, and the
 * preview says so rather than claiming 完整还原.
 */
export function resolveStrategy(mode: ImportMode, format: SourceFormat): ImportStrategy {
  if (mode === 'merge') return 'merge';
  return format === 'civic-envelope' ? 'canonical-restore' : 'legacy-replace';
}

/** True when the strategy clears the destination before writing. */
export function isReplaceStrategy(strategy: ImportStrategy): boolean {
  return strategy === 'canonical-restore' || strategy === 'legacy-replace';
}

export interface ImportConflict {
  readonly id: string;
  readonly incomingTitle: string;
  readonly existingTitle: string;
  readonly incomingDate: string;
  readonly existingDate: string;
  /** True when the two rows are byte-identical after normalisation. */
  readonly identical: boolean;
}

/** A progress entry that cannot be written because its id is already taken. */
export interface ProgressCollision {
  readonly id: string;
  readonly reason: 'duplicate-in-source' | 'exists-in-destination';
  readonly incomingNote: string;
}

export interface ImportPlan {
  readonly format: SourceFormat;
  readonly mode: ImportMode;
  /** The resolved semantics. Drives both the preview wording and `applyImportPlan`. */
  readonly strategy: ImportStrategy;
  /** True only for a canonical restore, which alone can replace categories/groups/settings. */
  readonly restoresTaxonomy: boolean;
  /** Records that will be written. */
  readonly accepted: readonly AnyRecord[];
  readonly acceptedProgress: readonly ProgressEntry[];
  /** Rows rejected outright, with a reason. */
  readonly rejected: readonly { readonly hint: string; readonly reason: string }[];
  /** Rows whose id already exists in the store. */
  readonly conflicts: readonly ImportConflict[];
  /** Ids appearing more than once inside the source file itself. */
  readonly duplicateIdsInSource: readonly string[];
  /** Progress ids appearing more than once inside the source file itself. */
  readonly duplicateProgressIdsInSource: readonly string[];
  /** Progress entries that cannot be written. Empty for replace strategies, which clear first. */
  readonly progressCollisions: readonly ProgressCollision[];
  /**
   * How much of the original database the source file can be trusted to contain.
   *
   * Null for a legacy file, which is not a canonical archive and never claimed to be one. Exposed
   * on the plan so the UI never has to re-inspect raw untyped input to decide what to say — and so
   * the decision is made once, where it can be tested.
   */
  readonly completeness: BackupCompleteness | null;
  /** What the file's checksum actually covers. v1/v2 digests did not cover completeness metadata. */
  readonly checksumScope: ChecksumScope | null;
  /** Relational defects that make an exact restore impossible. Empty for a healthy envelope. */
  readonly integrityIssues: readonly IntegrityIssue[];
  /**
   * True when this plan may perform an exact canonical restore.
   *
   * False for an incomplete archive, a relationally broken one, or any non-canonical source.
   */
  readonly exactRestorePossible: boolean;
  /**
   * True when the user must be told, before confirming, that completeness could not be verified.
   *
   * Set for a v1 archive: the format had no completeness field **and** the build that wrote it
   * could drop invalid rows without recording anything, so the absence of the field proves nothing.
   */
  readonly requiresCompletenessAcknowledgement: boolean;
  /** Existing records a replace strategy will destroy. Informational; zero in merge. */
  readonly replacesExisting: number;
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
  /** Progress entries dropped because of an id collision. */
  readonly progressCollisions: number;
}

/**
 * A stable signature of a record's *content*, ignoring audit timestamps.
 * Two records with the same signature are the same record however they were written.
 *
 * This must be a genuine deep canonical serialisation. Phase 1 used a JSON replacer array
 * (`JSON.stringify(rest, Object.keys(rest).sort())`), which is not one: a replacer array filters
 * property names at **every** depth, not only the top level. So every nested key whose name did
 * not also happen to be a top-level record key was dropped from the signature — including
 * `occurredOn.date`, both ends of a date range, and the whole of `legacyResidue`. Two records
 * differing only in their dates compared equal, and merge skipped the incoming one as an
 * "identical duplicate". `canonicalJson` (the serialiser the backup checksum already relies on)
 * sorts keys recursively and keeps every value.
 */
export function recordSignature(record: AnyRecord): string {
  const rest: Record<string, unknown> = { ...record };
  delete rest['updatedAt'];
  delete rest['createdAt'];
  return canonicalJson(rest);
}

export interface BuildPlanInput {
  readonly parsed: unknown;
  readonly mode: ImportMode;
  readonly existing: readonly AnyRecord[];
  /**
   * Ids of the destination's progress entries.
   *
   * Required for merge to guarantee it never overwrites an existing note. Ignored by the replace
   * strategies, which clear the table first. Optional so a caller that only previews a restore
   * need not read them, but the import dialog always supplies them.
   */
  readonly existingProgressIds?: readonly string[] | undefined;
}

/** Mutable working set shared by the source-shape collectors. */
interface PlanAccumulator {
  readonly accepted: AnyRecord[];
  readonly acceptedProgress: ProgressEntry[];
  readonly rejected: { hint: string; reason: string }[];
  readonly conflicts: ImportConflict[];
  readonly warnings: MigrationWarning[];
  readonly seenInSource: Set<string>;
  readonly duplicateIdsInSource: string[];
  readonly duplicateProgressIdsInSource: string[];
  readonly progressCollisions: ProgressCollision[];
  readonly seenProgressIds: Set<string>;
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
    duplicateProgressIdsInSource: [],
    progressCollisions: [],
    seenProgressIds: new Set<string>(),
  };
}

/** Everything a collector needs to know about the destination and the chosen semantics. */
interface CollectContext {
  readonly strategy: ImportStrategy;
  readonly recordsById: ReadonlyMap<string, AnyRecord>;
  readonly progressIds: ReadonlySet<string>;
}

/**
 * Classify one already-validated record.
 *
 * A duplicate id **inside the source file** is always a rejection: that is a defect in the file
 * and no strategy can sensibly write the row twice.
 *
 * A clash with the **destination** is only meaningful for `merge`. A replace strategy clears the
 * destination first, so the destination's ids are irrelevant — this is precisely the check that
 * Phase 1 applied unconditionally and that made restore delete everything.
 */
function placeRecord(record: AnyRecord, context: CollectContext, acc: PlanAccumulator): boolean {
  if (acc.seenInSource.has(record.id)) {
    acc.duplicateIdsInSource.push(record.id);
    acc.rejected.push({ hint: record.title, reason: '同一文件内出现重复 ID' });
    return false;
  }
  acc.seenInSource.add(record.id);

  if (context.strategy === 'merge') {
    const clash = context.recordsById.get(record.id);
    if (clash) {
      acc.conflicts.push(describeConflict(record, clash));
      return false;
    }
  }

  acc.accepted.push(record);
  return true;
}

/**
 * Classify one progress entry.
 *
 * Merge must never overwrite an existing note, so a collision with the destination is reported
 * and the entry is dropped. Phase 1 wrote progress with `bulkPut`, an upsert, so an incoming id
 * that happened to collide silently replaced the destination's note.
 */
function placeProgress(entry: ProgressEntry, context: CollectContext, acc: PlanAccumulator): void {
  if (acc.seenProgressIds.has(entry.id)) {
    /*
     * A repeated progress id inside one file. Merge and legacy replace report it and move on; a
     * canonical restore cannot, because dropping one of the two rows means the restored database
     * does not equal the archive. `planBlockers` refuses the restore for exactly this list — Phase
     * 1.1 recorded the collision, dropped the entry, and still labelled the operation 完整还原.
     */
    acc.duplicateProgressIdsInSource.push(entry.id);
    acc.progressCollisions.push({
      id: entry.id,
      reason: 'duplicate-in-source',
      incomingNote: entry.note,
    });
    return;
  }
  acc.seenProgressIds.add(entry.id);

  if (context.strategy === 'merge' && context.progressIds.has(entry.id)) {
    acc.progressCollisions.push({
      id: entry.id,
      reason: 'exists-in-destination',
      incomingNote: entry.note,
    });
    return;
  }
  acc.acceptedProgress.push(entry);
}

/** Records in a CivicWorkDesk envelope are already domain-shaped and schema-validated. */
function collectFromEnvelope(
  envelope: BackupEnvelope,
  context: CollectContext,
  acc: PlanAccumulator,
): void {
  for (const record of envelope.payload.records) {
    placeRecord(record, context, acc);
  }

  const acceptedIds = new Set(acc.accepted.map((record) => record.id));
  for (const entry of envelope.payload.progressEntries) {
    // A canonical restore reproduces the backup exactly, so every entry it carries is written.
    // Merge only adds notes whose record is actually being added, to avoid orphans.
    if (context.strategy === 'merge' && !acceptedIds.has(entry.recordId)) continue;
    placeProgress(entry, context, acc);
  }
}

/** Legacy rows must be normalised and then validated before they can be placed. */
function collectFromLegacyRows(
  rows: readonly unknown[],
  context: CollectContext,
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

    if (placeRecord(validated.data, context, acc)) {
      for (const entry of outcome.progress) placeProgress(entry, context, acc);
    }
  }
}

interface ExactnessVerdict {
  readonly completeness: BackupCompleteness | null;
  readonly integrityIssues: readonly IntegrityIssue[];
  readonly exactRestorePossible: boolean;
}

/**
 * Can this plan promise `restore(D, B(S)) = S`?
 *
 * Every clause is a way exactness can fail while each row still validates individually. Kept as one
 * function so the answer is defined in a single place and can be read as a list of conditions.
 */
function assessExactness(
  strategy: ImportStrategy,
  envelope: BackupEnvelope | null,
  acc: PlanAccumulator,
): ExactnessVerdict {
  if (strategy !== 'canonical-restore' || envelope === null) {
    // Only a canonical restore claims exactness, so nothing else needs the verdict.
    return {
      completeness: envelope?.completeness ?? null,
      integrityIssues: [],
      exactRestorePossible: false,
    };
  }
  const integrityIssues = validateCanonicalIntegrity(envelope);
  return {
    completeness: envelope.completeness,
    integrityIssues,
    exactRestorePossible:
      envelope.completeness !== 'incomplete' &&
      integrityIssues.length === 0 &&
      acc.duplicateIdsInSource.length === 0 &&
      acc.duplicateProgressIdsInSource.length === 0,
  };
}

/** Build a full preview. Performs no writes and mutates nothing the caller owns. */
export async function buildImportPlan(input: BuildPlanInput): Promise<ImportPlan> {
  const { format, rows, envelope } = detectSource(input.parsed);
  const strategy = resolveStrategy(input.mode, format);
  const context: CollectContext = {
    strategy,
    recordsById: new Map(input.existing.map((record) => [record.id, record])),
    progressIds: new Set(input.existingProgressIds ?? []),
  };
  const acc = emptyAccumulator();

  if (format === 'civic-envelope' && envelope) {
    collectFromEnvelope(envelope, context, acc);
  } else {
    collectFromLegacyRows(rows, context, acc);
  }

  const { accepted, acceptedProgress, rejected, conflicts, warnings, duplicateIdsInSource } = acc;
  const checksum = envelope ? await verifyChecksum(envelope) : null;
  const identicalConflicts = conflicts.filter((c) => c.identical).length;

  // Only a canonical envelope carries taxonomy and settings, so only it can restore them.
  const restoresTaxonomy = strategy === 'canonical-restore' && envelope !== null;

  /*
   * Completeness and relational integrity are decided here, once, and carried on the plan. The UI
   * must never re-derive them from raw input: Phase 1.1 exposed `omittedInvalidRowIds` in the file
   * and nothing consulted it, so an archive that declared itself incomplete was still offered as
   * 完整还原.
   */
  const exactness = assessExactness(strategy, envelope, acc);
  const { completeness, integrityIssues, exactRestorePossible } = exactness;

  return {
    format,
    mode: input.mode,
    strategy,
    restoresTaxonomy,
    accepted,
    acceptedProgress,
    rejected,
    conflicts,
    duplicateIdsInSource,
    duplicateProgressIdsInSource: acc.duplicateProgressIdsInSource,
    progressCollisions: acc.progressCollisions,
    replacesExisting: isReplaceStrategy(strategy) ? input.existing.length : 0,
    warnings,
    categories: envelope?.payload.categories ?? null,
    groups: envelope?.payload.groups ?? null,
    settings: envelope?.payload.settings ?? null,
    completeness,
    checksumScope: envelope?.checksum.scope ?? null,
    integrityIssues,
    exactRestorePossible,
    requiresCompletenessAcknowledgement:
      strategy === 'canonical-restore' && completeness === 'unknown-legacy',
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
      progressCollisions: acc.progressCollisions.length,
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
