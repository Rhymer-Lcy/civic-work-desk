import { withDatabase } from '@/db/client';
import { META_KEY, SETTINGS_KEY } from '@/db/schema';
import { appSettingsSchema } from '@/domain/validation';
import { nowInstant } from '@/utils/clock';
import type { ImportPlan } from './plan';
import { planBlockers } from './plan';

/**
 * Apply a previewed import.
 *
 * **One transaction covers every table the strategy touches**, so an import either lands
 * completely or not at all. Nothing is recomputed here: the plan decided what would be written,
 * the preview showed exactly that, and this function writes it.
 *
 * The three strategies differ only in what they clear first and what they restore:
 *
 * | strategy | records + progress | categories + groups | settings |
 * | --- | --- | --- | --- |
 * | `merge` | add only (never overwrite) | add if missing | untouched |
 * | `canonical-restore` | cleared, then restored exactly | cleared, then restored exactly | replaced |
 * | `legacy-replace` | cleared, then replaced | untouched | untouched |
 *
 * `meta` is deliberately **not** restored from a backup. It holds application-internal
 * bookkeeping — the database schema version and backup-health state — which describes *this
 * installation*, not the archive. It is updated (not replaced) after a restore so the freshly
 * restored data is correctly reported as matching a known backup.
 */

export interface ImportOutcome {
  readonly strategy: ImportPlan['strategy'];
  readonly recordsWritten: number;
  readonly progressWritten: number;
  readonly categoriesWritten: number;
  readonly groupsWritten: number;
  readonly settingsReplaced: boolean;
  readonly recordsDestroyed: number;
  readonly progressDestroyed: number;
  readonly taxonomyReplaced: boolean;
}

export class ImportBlockedError extends Error {
  override readonly name = 'ImportBlockedError';
  readonly blockers: readonly string[];
  constructor(blockers: readonly string[]) {
    super(`import refused: ${blockers.join(' ')}`);
    this.blockers = blockers;
  }
}

export async function applyImportPlan(plan: ImportPlan): Promise<ImportOutcome> {
  const blockers = planBlockers(plan);
  if (blockers.length > 0) throw new ImportBlockedError(blockers);

  return withDatabase('applyImportPlan', (db) =>
    db.transaction(
      'rw',
      [db.records, db.progressEntries, db.categories, db.groups, db.settings, db.meta],
      async (): Promise<ImportOutcome> => {
        const clearsRecords = plan.strategy !== 'merge';
        let recordsDestroyed = 0;
        let progressDestroyed = 0;

        if (clearsRecords) {
          recordsDestroyed = await db.records.count();
          progressDestroyed = await db.progressEntries.count();
          await db.records.clear();
          await db.progressEntries.clear();
        }

        // `bulkAdd`, never `bulkPut`. After a clear the table is empty so add is correct, and in
        // merge it makes the non-overwrite guarantee structural: if the plan were ever wrong the
        // database rejects the write instead of silently replacing a row.
        if (plan.accepted.length > 0) await db.records.bulkAdd([...plan.accepted]);
        if (plan.acceptedProgress.length > 0) {
          await db.progressEntries.bulkAdd([...plan.acceptedProgress]);
        }

        let categoriesWritten = 0;
        let groupsWritten = 0;
        let settingsReplaced = false;

        if (plan.restoresTaxonomy) {
          // Exact restore: the backup's taxonomy replaces the local one wholesale. Keeping a
          // locally renamed category merely because its id already existed would mean the restored
          // database did not match the backup, which is the one thing a restore must guarantee.
          await db.categories.clear();
          await db.groups.clear();
          if (plan.categories && plan.categories.length > 0) {
            await db.categories.bulkAdd([...plan.categories]);
            categoriesWritten = plan.categories.length;
          }
          if (plan.groups && plan.groups.length > 0) {
            await db.groups.bulkAdd([...plan.groups]);
            groupsWritten = plan.groups.length;
          }
          if (plan.settings) {
            const validated = appSettingsSchema.safeParse(plan.settings);
            if (!validated.success) {
              throw new Error('备份中的设置未通过校验，已中止还原。');
            }
            await db.settings.put({ key: SETTINGS_KEY, value: validated.data });
            settingsReplaced = true;
          }
        } else if (plan.strategy === 'merge' && plan.categories) {
          // Merge adds taxonomy the destination lacks and leaves local names alone: a rename made
          // here is a deliberate local decision, and merging records should not revert it.
          for (const category of plan.categories) {
            if (!(await db.categories.get(category.id))) {
              await db.categories.add(category);
              categoriesWritten += 1;
            }
          }
          if (plan.groups) {
            for (const group of plan.groups) {
              if (!(await db.groups.get(group.id))) {
                await db.groups.add(group);
                groupsWritten += 1;
              }
            }
          }
        }

        await stampMeta(db, plan);

        return {
          strategy: plan.strategy,
          recordsWritten: plan.accepted.length,
          progressWritten: plan.acceptedProgress.length,
          categoriesWritten,
          groupsWritten,
          settingsReplaced,
          recordsDestroyed,
          progressDestroyed,
          taxonomyReplaced: plan.restoresTaxonomy,
        };
      },
    ),
  );
}

/**
 * Update backup-health bookkeeping inside the same transaction.
 *
 * After an exact canonical restore the database *is* the backup, so the user holds a file that
 * matches it: the backup state is recorded as current. Every other strategy is an ordinary data
 * mutation and must mark the backup stale.
 */
async function stampMeta(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  plan: ImportPlan,
): Promise<void> {
  const row = await db.meta.get(META_KEY);
  if (!row) return;
  const revision = row.value.dataRevision + 1;

  if (plan.strategy === 'canonical-restore') {
    await db.meta.put({
      key: META_KEY,
      value: {
        ...row.value,
        dataRevision: revision,
        lastBackupAt: nowInstant(),
        lastBackupRevision: revision,
        lastBackupRecordCount: plan.accepted.length,
      },
    });
    return;
  }

  await db.meta.put({ key: META_KEY, value: { ...row.value, dataRevision: revision } });
}
