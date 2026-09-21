import { validateRelationalIntegrity } from '@/domain/integrity';
import type { IntegrityIssue } from '@/domain/integrity';
import type { AnyRecord, BusinessCategory, ProgressEntry, WorkGroup } from '@/domain/types';
import type { BackupEnvelope } from '../backup/envelope';

/**
 * Relational integrity at the import boundary.
 *
 * The rules themselves live in `@/domain/integrity` — one definition shared by canonical restore,
 * live-store diagnostics, backup viability and the merge planner. Phase 1.2 kept them here, reachable
 * only from the importer, which is how the live database came to be allowed a state its own backups
 * could not restore.
 *
 * This module is the adapter: it knows about envelopes and about projecting a merge's final state,
 * and delegates every judgement about what "valid" means.
 */

export type { IntegrityIssue, IntegrityIssueKind } from '@/domain/integrity';
export { describeIntegrityIssues } from '@/domain/integrity';

/**
 * Validate a canonical envelope as the complete state it claims to be.
 *
 * An exact restore promises `restore(D, B(S)) = S`. Every check can fail while each individual row
 * passes its schema: a duplicate id means one row must be dropped, an orphan progress note belongs to
 * nothing, a dangling reference cannot be resolved by the restored database.
 *
 * The policy is **refuse, never repair**. Silently dropping the orphan or nulling the dangling
 * reference would produce a database that does not match the file the user was told it restored.
 */
export function validateCanonicalIntegrity(envelope: BackupEnvelope): IntegrityIssue[] {
  return validateRelationalIntegrity({
    records: envelope.payload.records,
    progressEntries: envelope.payload.progressEntries,
    categories: envelope.payload.categories,
    groups: envelope.payload.groups,
  });
}

/**
 * The state a merge would leave behind: destination plus everything the plan accepts.
 *
 * Phase 1.2 evaluated an incoming progress entry against *newly accepted source records only*, so a
 * perfectly valid note for a record the destination already held was skipped — the commonest real
 * merge there is. And it evaluated nothing at all for taxonomy or honour references, so a merge could
 * introduce the very dangling reference a restore would refuse.
 *
 * Both follow from the same mistake: judging a reference against a fragment instead of against the
 * state that will actually exist. `finalState = destination + acceptedChanges` is the only view in
 * which "does this reference resolve?" has a correct answer.
 */
export interface ProjectedStateInput {
  readonly destination: {
    readonly records: readonly AnyRecord[];
    readonly progressEntries: readonly ProgressEntry[];
    readonly categories: readonly BusinessCategory[];
    readonly groups: readonly WorkGroup[];
  };
  readonly accepted: {
    readonly records: readonly AnyRecord[];
    readonly progressEntries: readonly ProgressEntry[];
    readonly categories: readonly BusinessCategory[];
    readonly groups: readonly WorkGroup[];
  };
}

/** Merge the destination and the accepted set into the state that would exist after the write. */
export function projectFinalState(input: ProjectedStateInput) {
  return {
    records: [...input.destination.records, ...input.accepted.records],
    progressEntries: [...input.destination.progressEntries, ...input.accepted.progressEntries],
    categories: [...input.destination.categories, ...input.accepted.categories],
    groups: [...input.destination.groups, ...input.accepted.groups],
  };
}

/** Validate the projected final state of a merge. */
export function validateProjectedState(input: ProjectedStateInput): IntegrityIssue[] {
  return validateRelationalIntegrity(projectFinalState(input));
}
