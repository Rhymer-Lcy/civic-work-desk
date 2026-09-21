import { withDatabase } from '@/db/client';
import { SETTINGS_KEY } from '@/db/schema';
import { appSettingsSchema } from '@/domain/validation';
import type { ImportPlan } from './plan';
import { planBlockers } from './plan';

/**
 * Apply a previewed import.
 *
 * One transaction covers every table the plan touches, so an import either lands completely or
 * not at all. Nothing is recomputed here: the plan decided what would be written, the preview
 * showed exactly that, and this function writes it.
 */

export interface ImportOutcome {
  readonly recordsWritten: number;
  readonly progressWritten: number;
  readonly categoriesWritten: number;
  readonly groupsWritten: number;
  readonly settingsReplaced: boolean;
  readonly recordsDestroyed: number;
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
      [db.records, db.progressEntries, db.categories, db.groups, db.settings],
      async (): Promise<ImportOutcome> => {
        let recordsDestroyed = 0;

        if (plan.mode === 'replace') {
          recordsDestroyed = await db.records.count();
          await db.records.clear();
          await db.progressEntries.clear();
        }

        if (plan.accepted.length > 0) {
          await db.records.bulkPut(plan.accepted);
        }
        if (plan.acceptedProgress.length > 0) {
          await db.progressEntries.bulkPut(plan.acceptedProgress);
        }

        // Taxonomy is merged by id in both modes. A category the file brings but the store lacks
        // is added; one the store already has keeps its local name, because a rename made here is
        // a deliberate local decision and an import should not silently revert it.
        let categoriesWritten = 0;
        if (plan.categories) {
          for (const category of plan.categories) {
            const existing = await db.categories.get(category.id);
            if (!existing) {
              await db.categories.add(category);
              categoriesWritten += 1;
            }
          }
        }
        let groupsWritten = 0;
        if (plan.groups) {
          for (const group of plan.groups) {
            const existing = await db.groups.get(group.id);
            if (!existing) {
              await db.groups.add(group);
              groupsWritten += 1;
            }
          }
        }

        // Settings are adopted only in replace mode: a merge is about records, and silently
        // rewriting the product title from a colleague's backup would be surprising.
        let settingsReplaced = false;
        if (plan.mode === 'replace' && plan.settings) {
          const validated = appSettingsSchema.safeParse(plan.settings);
          if (validated.success) {
            await db.settings.put({ key: SETTINGS_KEY, value: validated.data });
            settingsReplaced = true;
          }
        }

        return {
          recordsWritten: plan.accepted.length,
          progressWritten: plan.acceptedProgress.length,
          categoriesWritten,
          groupsWritten,
          settingsReplaced,
          recordsDestroyed,
        };
      },
    ),
  );
}
