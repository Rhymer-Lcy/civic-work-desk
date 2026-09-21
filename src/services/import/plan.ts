import { primaryDate } from '@/domain/types';
import type { AnyRecord, ProgressEntry } from '@/domain/types';
import { formatDateValue } from '@/domain/dates';
import { anyRecordSchema, describeIssues } from '@/domain/validation';
import { canonicalJson, countsAreConsistent, verifyChecksum } from '../backup/envelope';
import type { BackupCompleteness, ChecksumScope } from '../backup/compatibility';
import { detectSource } from './detect';
import type { SourceFormat } from './detect';
import type { BackupEnvelope, ChecksumVerdict } from '../backup/envelope';
import { validateCanonicalIntegrity } from './integrity';
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
   * Rows declined because a reference would not resolve in the projected final state.
   *
   * Reported rather than repaired: rewriting the reference to null would alter the user's data, and
   * inventing the missing category would invent taxonomy that never existed.
   */
  readonly referenceRejections: readonly { readonly id: string; readonly reason: string }[];
  /** Progress entries declined because their record would not exist after the write. */
  readonly orphanProgress: readonly { readonly id: string; readonly recordId: string }[];
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
  /** Rows declined because a reference would not resolve after the write. */
  readonly referenceRejections: number;
  /** Progress entries declined for having no record in the projected final state. */
  readonly orphanProgress: number;
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
   * **Required**, like the taxonomy ids below. It is what guarantees merge never overwrites an
   * existing note, and since a merge now accepts a valid note for a record the destination already
   * holds (the Phase-1.2 defect), an omitted list would let the planner propose writing an id that is
   * already taken — a preview that disagrees with what the write can do. Phase 1.2 allowed it to be
   * optional; the write then failed with a raw `ConstraintError` instead of reporting a collision.
   * A replace strategy passes the list truthfully and the planner ignores it, because it clears first.
   */
  readonly existingProgressIds: readonly string[];
  /**
   * Ids of the destination's business categories and groups.
   *
   * **Required**, and deliberately not optional. The planner judges an incoming record's category and
   * group against the projected final taxonomy; a caller that omitted them would be telling it the
   * destination has none, and every record carrying a category reference would be rejected as
   * unresolvable. Defaulting to an empty list would turn a missing argument into silently dropped
   * data, so the type insists. A canonical restore passes `[]` truthfully — it replaces the taxonomy
   * wholesale, so the destination's ids are irrelevant.
   */
  readonly existingCategoryIds: readonly string[];
  readonly existingGroupIds: readonly string[];
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
  /** Rows declined because a reference would not resolve after the write. */
  readonly referenceRejections: { id: string; reason: string }[];
  /** Progress entries declined because their record would not exist after the write. */
  readonly orphanProgress: { id: string; recordId: string }[];
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
    referenceRejections: [],
    orphanProgress: [],
  };
}

/**
 * Everything a collector needs: the destination, the chosen semantics, and the **projected** state.
 *
 * The projected sets are the heart of the Phase-1.3 merge fix. A reference is valid when it resolves
 * in the state that will exist *after* the write — `destination + acceptedChanges` — not when it
 * resolves inside the incoming file alone. Phase 1.2 judged an incoming progress entry against the
 * records accepted from the same file, so a perfectly good note for a record the destination already
 * held was silently skipped: the commonest real merge there is.
 *
 * The same view closes the opposite hole. Phase 1.2 checked nothing at all for an incoming record's
 * category, group or related-work reference in merge mode, so a merge could introduce exactly the
 * dangling reference a canonical restore refuses.
 */
interface CollectContext {
  readonly strategy: ImportStrategy;
  readonly recordsById: ReadonlyMap<string, AnyRecord>;
  readonly progressIds: ReadonlySet<string>;
  /** Category ids that will exist after the write. */
  readonly projectedCategoryIds: ReadonlySet<string>;
  /** Group ids that will exist after the write. */
  readonly projectedGroupIds: ReadonlySet<string>;
  /** Record ids that will exist after the write, and which of them are work records. */
  readonly projectedRecordIds: Set<string>;
  readonly projectedWorkIds: Set<string>;
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

  /*
   * Would writing this row leave a reference unresolved in the projected final state?
   *
   * Rejecting it is the only safe answer. Rewriting the reference to null would silently alter the
   * user's data, and inventing the missing category or group would invent taxonomy that never
   * existed — both are worse than declining the row and saying why. This is also what makes an
   * *incomplete* archive safe to merge: a record whose category was omitted from the file, and which
   * the destination does not have either, is refused rather than written with a broken link.
   */
  const unresolved = unresolvedReference(record, context);
  if (unresolved !== null) {
    acc.rejected.push({ hint: record.title, reason: unresolved });
    acc.referenceRejections.push({ id: record.id, reason: unresolved });
    return false;
  }

  acc.accepted.push(record);
  context.projectedRecordIds.add(record.id);
  if (record.kind === 'work') context.projectedWorkIds.add(record.id);
  return true;
}

/** The reason this record's references cannot be satisfied, or null when they all resolve. */
function unresolvedReference(record: AnyRecord, context: CollectContext): string | null {
  if (record.kind === 'work') {
    if (record.categoryId !== null && !context.projectedCategoryIds.has(record.categoryId)) {
      return `引用的业务分类在导入后仍不存在（${record.categoryId}）`;
    }
    if (record.groupId !== null && !context.projectedGroupIds.has(record.groupId)) {
      return `引用的归属分组在导入后仍不存在（${record.groupId}）`;
    }
    return null;
  }
  if (record.relatedWorkId === null) return null;
  if (!context.projectedWorkIds.has(record.relatedWorkId)) {
    return `引用的关联工作记录在导入后仍不存在（${record.relatedWorkId}）`;
  }
  return null;
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

  /*
   * The note's record must exist after the write — whether it is being imported now or was already
   * in the destination. That second case is the Phase-1.2 defect: a valid note for an existing record
   * was skipped because the record was not part of *this* import.
   */
  if (!context.projectedRecordIds.has(entry.recordId)) {
    acc.orphanProgress.push({ id: entry.id, recordId: entry.recordId });
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
  /*
   * Work records first, then honours, then progress — dependency order.
   *
   * An honour's `relatedWorkId` may point at a work record from the same file, and a progress entry's
   * `recordId` may point at either. Placing them in reference order means every decision is made with
   * the projected state already containing everything it could legitimately depend on, so one pass
   * suffices and the outcome does not depend on the order rows happen to appear in the file.
   */
  for (const record of envelope.payload.records) {
    if (record.kind === 'work') placeRecord(record, context, acc);
  }
  for (const record of envelope.payload.records) {
    if (record.kind === 'honor') placeRecord(record, context, acc);
  }
  for (const entry of envelope.payload.progressEntries) {
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
      // The record is now in the projected state, so its notes resolve.
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

/**
 * Seed the projected final state for the chosen strategy.
 *
 * What the destination contributes depends on what the strategy clears:
 *
 * | strategy | destination records | destination taxonomy |
 * | --- | --- | --- |
 * | `merge` | kept | kept |
 * | `canonical-restore` | cleared | cleared, then replaced by the file |
 * | `legacy-replace` | cleared | **kept** — a legacy file carries none |
 *
 * The taxonomy a merge will end up with is the destination's plus whatever the file adds, because
 * `applyImportPlan` adds categories and groups the destination lacks. A canonical restore's taxonomy
 * is the file's alone. A legacy replace keeps the local taxonomy, which is why its records' category
 * references are judged against the *destination* — the case that would otherwise dangle.
 */
function buildCollectContext(
  input: BuildPlanInput,
  strategy: ImportStrategy,
  envelope: BackupEnvelope | null,
): CollectContext {
  const destinationRecords = isReplaceStrategy(strategy) ? [] : input.existing;
  const keepsLocalTaxonomy = strategy !== 'canonical-restore';

  const categoryIds = new Set<string>(keepsLocalTaxonomy ? input.existingCategoryIds : []);
  const groupIds = new Set<string>(keepsLocalTaxonomy ? input.existingGroupIds : []);
  for (const category of envelope?.payload.categories ?? []) categoryIds.add(category.id);
  for (const group of envelope?.payload.groups ?? []) groupIds.add(group.id);

  return {
    strategy,
    recordsById: new Map(input.existing.map((record) => [record.id, record])),
    progressIds: new Set(isReplaceStrategy(strategy) ? [] : input.existingProgressIds),
    projectedCategoryIds: categoryIds,
    projectedGroupIds: groupIds,
    projectedRecordIds: new Set(destinationRecords.map((record) => record.id)),
    projectedWorkIds: new Set(
      destinationRecords.filter((record) => record.kind === 'work').map((record) => record.id),
    ),
  };
}

/** Build a full preview. Performs no writes and mutates nothing the caller owns. */
export async function buildImportPlan(input: BuildPlanInput): Promise<ImportPlan> {
  const { format, rows, envelope } = detectSource(input.parsed);
  const strategy = resolveStrategy(input.mode, format);
  const context = buildCollectContext(input, strategy, envelope);
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
    referenceRejections: acc.referenceRejections,
    orphanProgress: acc.orphanProgress,
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
      referenceRejections: acc.referenceRejections.length,
      orphanProgress: acc.orphanProgress.length,
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

/*
 * Policy lives in ./policy.ts since Phase 1.3, when this module outgrew its line budget.
 * Re-exported here so `planBlockers`, `planWritesAnything` and `RESOLUTION_POLICY` keep their
 * existing import path: the split is internal organisation, not an API change.
 */
export {
  RESOLUTION_POLICY,
  envelopeCompleteness,
  planBlockers,
  planWritesAnything,
} from './policy';
