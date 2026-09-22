import { partitionRows } from '@/db/invalid-row';
import { describeIntegrityIssues, validateRelationalIntegrity } from '@/domain/integrity';
import type { AnyRecord, BusinessCategory, ProgressEntry, WorkGroup } from '@/domain/types';
import {
  anyRecordSchema,
  businessCategorySchema,
  progressEntrySchema,
  workGroupSchema,
} from '@/domain/validation';
import { projectFinalState } from './integrity';
import type { ImportPlan } from './plan';

/**
 * The final check between "the user confirmed a preview" and "the database is written".
 *
 * A preview is a statement about the destination **at the moment it was built**. Phase 1.3 made the
 * planner judge every reference against the state that would exist after the write
 * (`destination + acceptedChanges`), which closed the merge defects — but it computed that projection
 * once, from a destination read before the dialog was even shown. Another tab can mutate IndexedDB
 * while the dialog sits open, so by the time the user clicks confirm the preview may describe a
 * destination that no longer exists. Applying it then is a time-of-check / time-of-use gap: the plan
 * was safe when checked and unsafe when used.
 *
 * Two properties make the check sound, and both are structural rather than a matter of care:
 *
 *   - **it runs inside the same Dexie transaction as the writes.** Revalidating, ending the
 *     transaction and opening a second one to write would reproduce the identical bug over a shorter
 *     interval. IndexedDB gives no way to observe another transaction's write inside ours, so a check
 *     that passes here cannot be invalidated before the write it authorises.
 *   - **it reuses `@/domain/integrity`.** There is one definition of relational validity in this
 *     codebase, shared by canonical restore, live diagnostics, backup viability, the merge planner
 *     and now the apply path. A second definition here would be a second thing to keep in step.
 *
 * The outcome is deliberately narrow: a stale plan is **refused**, never repaired. Nulling a
 * reference that stopped resolving, or re-deriving the accepted set against the new destination,
 * would both write something the user never previewed. The user approved a specific preview; if the
 * destination moved out from under it, the honest answer is to ask for a new one.
 */

/**
 * The destination as it exists *now*, read inside the write transaction.
 *
 * The four entity lists hold rows that **passed their schema**, because the relational rules in
 * `@/domain/integrity` are defined over typed rows: a stored row missing `categoryId` entirely is
 * schema damage, and feeding it to a validator that reads `record.categoryId !== null` would report it
 * as a *dangling reference* instead — a different defect, in a different place, with a different fix.
 * Corrupt rows are reported by `readStoreSnapshot()` and repaired through Diagnostics; that is where
 * they are handled, and an import must not silently inherit their diagnosis.
 *
 * `occupiedIds` is the separate, deliberately wider question: which primary keys are *physically
 * present*. A corrupt row still occupies its key, so a merge that tried to add that id would be
 * overwriting real data. Non-overwrite is checked against this set, relational validity against the
 * parsed rows above — two questions, two inputs, neither standing in for the other.
 */
export interface CurrentDestination {
  readonly records: readonly AnyRecord[];
  readonly progressEntries: readonly ProgressEntry[];
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly occupiedIds: {
    readonly records: ReadonlySet<string>;
    readonly progressEntries: ReadonlySet<string>;
  };
}

/**
 * A confirmed import that may no longer be applied.
 *
 * Distinct from `ImportBlockedError`, which means *this plan was never applicable*. A stale plan was
 * applicable when it was previewed; nothing is wrong with the file, and the remedy is different — build
 * a new preview and confirm that instead. Carries no Dexie or IndexedDB detail: the user is told what
 * happened to their data and what to do, not which store rejected which key.
 */
export class StaleImportPlanError extends Error {
  override readonly name = 'StaleImportPlanError';
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(
      '本机数据在生成导入预览之后发生了变化，为避免写入不一致的数据，本次导入已整体中止，' +
        `未写入任何内容。请关闭后重新选择文件生成预览，再次确认。原因：${reasons.join('；')}`,
    );
    this.reasons = reasons;
  }
}

/**
 * Walk an error's `cause` chain for a stale-plan error.
 *
 * Dexie aborts a transaction by rejecting with the error the callback threw, and `withDatabase` then
 * wraps whatever it catches in a `DatabaseError`. Without this the apply path would surface a
 * wrapper whose class no caller can test for, and the UI would print "applyImportPlan failed: …".
 */
export function findStaleImportPlanError(cause: unknown): StaleImportPlanError | null {
  let current = cause;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof StaleImportPlanError) return current;
    current = current.cause;
  }
  return null;
}

/**
 * Is this the database refusing a key that already exists?
 *
 * `bulkAdd` remains the structural last guard against overwriting a row — it is never replaced by
 * `bulkPut`. But a raw `ConstraintError` (or the `BulkError` Dexie wraps several of them in) is an
 * implementation detail; reaching the user it would say nothing about what to do. The preflight
 * normally explains the collision first, so this is the path for a collision that appears in the
 * narrow window the preflight itself cannot cover.
 */
export function isKeyCollisionError(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.name === 'ConstraintError' || current.name === 'BulkError') return true;
    if (current.message.includes('ConstraintError')) return true;
    const failures: unknown = (current as { failures?: unknown }).failures;
    if (Array.isArray(failures) && failures.some((failure) => isKeyCollisionError(failure))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function describe(issues: ReturnType<typeof validateRelationalIntegrity>): string {
  return describeIntegrityIssues(issues, 'store').join('、');
}

/**
 * Taxonomy a merge would actually add, under the documented local-wins rule.
 *
 * `applyImportPlan` adds a category or group only when its id is absent, so an id the destination
 * already holds keeps the local row — including a local rename. The projection must model that, not
 * the file's version, or the check would validate a state the write will not produce. It also keeps
 * the local-wins rule unambiguous: at most one row per id is ever present.
 */
function mergeTaxonomyAdditions(
  plan: ImportPlan,
  current: CurrentDestination,
): { categories: BusinessCategory[]; groups: WorkGroup[] } {
  const currentCategoryIds = new Set(current.categories.map((category) => category.id));
  const currentGroupIds = new Set(current.groups.map((group) => group.id));
  return {
    categories: (plan.categories ?? []).filter((category) => !currentCategoryIds.has(category.id)),
    groups: (plan.groups ?? []).filter((group) => !currentGroupIds.has(group.id)),
  };
}

/**
 * Every reason this confirmed plan may not be written against `current`. Empty means proceed.
 *
 * Pure over its inputs so the rule can be tested without a database, and so the transaction body
 * stays a thin reader. The three strategies are genuinely different questions, not one question with
 * flags:
 *
 * | strategy | what the final state is | does destination drift matter? |
 * | --- | --- | --- |
 * | `merge` | current destination + accepted changes | **yes** — the destination survives the write |
 * | `legacy-replace` | accepted records/progress + **current** taxonomy | **taxonomy only** |
 * | `canonical-restore` | the archive, exactly | **no** — it replaces every restoreable store |
 */
export function evaluateImportPreflight(plan: ImportPlan, current: CurrentDestination): string[] {
  if (plan.strategy === 'canonical-restore') {
    /*
     * An exact restore is defined as `restore(D, B(S)) = S` for an arbitrary destination `D`, so
     * destination drift is not a reason to refuse it — the archive replaces records, progress,
     * categories, groups and settings wholesale. Only the archive itself can be at fault, and the
     * plan's own integrity is already blocking upstream. Re-checked here over the state the write
     * will actually produce, because this is the last point before it happens.
     */
    const issues = validateRelationalIntegrity({
      records: plan.accepted,
      progressEntries: plan.acceptedProgress,
      categories: plan.categories ?? [],
      groups: plan.groups ?? [],
    });
    return issues.length === 0
      ? []
      : [`备份文件的关联关系不自洽（${String(issues.length)} 处）：${describe(issues)}`];
  }

  if (plan.strategy === 'legacy-replace') {
    /*
     * A legacy file carries no taxonomy: it replaces records and progress and leaves categories and
     * groups alone. So its records must be valid against the taxonomy that exists **at commit time**,
     * not the taxonomy that existed when the preview was built — a category deleted in another tab
     * while the dialog was open would otherwise be written as a dangling reference.
     */
    const issues = validateRelationalIntegrity({
      records: plan.accepted,
      progressEntries: plan.acceptedProgress,
      categories: current.categories,
      groups: current.groups,
    });
    return issues.length === 0
      ? []
      : [
          `按该预览替换后，记录与本机现有的业务分类 / 归属分组不再自洽（${String(issues.length)} 处）：` +
            describe(issues),
        ];
  }

  const reasons: string[] = [];

  /*
   * Non-overwrite, re-checked against the destination as it is now. The preview reported collisions
   * against the destination it read; an id that arrived afterwards was invisible to it. Reported
   * before the projection because "this id is now taken" is a more useful sentence than the
   * duplicate-id issue the validator would otherwise raise for the same rows.
   */
  const collidingRecords = plan.accepted.filter((record) =>
    current.occupiedIds.records.has(record.id),
  );
  if (collidingRecords.length > 0) {
    reasons.push(
      `有 ${String(collidingRecords.length)} 条待导入记录的 ID 现在已存在于本机` +
        `（${collidingRecords
          .slice(0, 3)
          .map((record) => record.id)
          .join('、')}），合并导入不会覆盖本机数据`,
    );
  }

  const collidingProgress = plan.acceptedProgress.filter((entry) =>
    current.occupiedIds.progressEntries.has(entry.id),
  );
  if (collidingProgress.length > 0) {
    reasons.push(
      `有 ${String(collidingProgress.length)} 条待导入进展的 ID 现在已存在于本机` +
        `（${collidingProgress
          .slice(0, 3)
          .map((entry) => entry.id)
          .join('、')}）`,
    );
  }

  const additions = mergeTaxonomyAdditions(plan, current);
  const projected = projectFinalState({
    destination: {
      records: current.records,
      progressEntries: current.progressEntries,
      categories: current.categories,
      groups: current.groups,
    },
    accepted: {
      records: plan.accepted,
      progressEntries: plan.acceptedProgress,
      categories: additions.categories,
      groups: additions.groups,
    },
  });
  const issues = validateRelationalIntegrity(projected);
  if (issues.length > 0) {
    /*
     * Say which side is broken. A destination that is *already* relationally corrupt is not a stale
     * preview — it is damage the user needs to see and repair through Diagnostics, and stacking an
     * import on top of it would only make the projected state look like the import's fault. Either
     * way the merge is refused: §7 does not ask for a repair workflow here, it asks that the import
     * not add data on top of a broken destination while claiming the result is safe.
     */
    const preexisting = validateRelationalIntegrity({
      records: current.records,
      progressEntries: current.progressEntries,
      categories: current.categories,
      groups: current.groups,
    });
    reasons.push(
      preexisting.length > 0
        ? `本机数据当前本身存在关联关系问题（${String(preexisting.length)} 处）：${describe(preexisting)}。` +
            '请先在「设置 → 诊断」中处理，再导入'
        : `按该预览写入后关联关系将不自洽（${String(issues.length)} 处）：${describe(issues)}`,
    );
  }

  return reasons;
}

/** The raw stores this check reads. Structural, so the transaction's own tables satisfy it. */
interface ReadableStores {
  readonly records: { toArray: () => Promise<unknown[]> };
  readonly progressEntries: { toArray: () => Promise<unknown[]> };
  readonly categories: { toArray: () => Promise<unknown[]> };
  readonly groups: { toArray: () => Promise<unknown[]> };
}

/**
 * Read the current destination and evaluate the plan, throwing if it has gone stale.
 *
 * **Must be called from inside the write transaction**, with `records`, `progressEntries`,
 * `categories` and `groups` in its scope; the caller's transaction is what makes the check atomic
 * with respect to the writes it authorises. `settings` and `meta` are in the same transaction
 * because the write touches them, though nothing here reads them: neither influences relational
 * validity, and a canonical restore replaces settings outright.
 *
 * Rows are read raw and partitioned with `partitionRows` — the same helper `readStoreSnapshot()` uses,
 * so "which rows are valid" has one answer in this codebase rather than one per caller.
 */
export async function preflightImportPlan(db: ReadableStores, plan: ImportPlan): Promise<void> {
  const [rawRecords, rawProgress, rawCategories, rawGroups] = await Promise.all([
    db.records.toArray(),
    db.progressEntries.toArray(),
    db.categories.toArray(),
    db.groups.toArray(),
  ]);

  const parse =
    <T>(schema: { safeParse: (row: unknown) => { success: boolean; data?: T; error?: unknown } }) =>
    (row: unknown) => {
      const result = schema.safeParse(row);
      return result.success && result.data !== undefined
        ? ({ ok: true, value: result.data } as const)
        : ({ ok: false, reason: 'schema' } as const);
    };

  const records = partitionRows<AnyRecord>(rawRecords, parse(anyRecordSchema));
  const progressEntries = partitionRows<ProgressEntry>(rawProgress, parse(progressEntrySchema));
  const categories = partitionRows<BusinessCategory>(rawCategories, parse(businessCategorySchema));
  const groups = partitionRows<WorkGroup>(rawGroups, parse(workGroupSchema));

  const reasons = evaluateImportPreflight(plan, {
    records: records.valid,
    progressEntries: progressEntries.valid,
    categories: categories.valid,
    groups: groups.valid,
    occupiedIds: {
      records: new Set(rawRecords.map(readRowId).filter((id): id is string => id !== null)),
      progressEntries: new Set(
        rawProgress.map(readRowId).filter((id): id is string => id !== null),
      ),
    },
  });
  if (reasons.length > 0) throw new StaleImportPlanError(reasons);
}

/** A row's primary key, however invalid the rest of it is. */
function readRowId(row: unknown): string | null {
  if (row === null || typeof row !== 'object') return null;
  const id: unknown = (row as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '' ? id : null;
}
