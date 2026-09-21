import type { CivicWorkDeskDatabase } from '../schema';
import { META_KEY, SCHEMA_VERSION, SETTINGS_KEY } from '../schema';
import { defaultCategories, defaultGroups, defaultSettings } from '@/domain/defaults';
import { nowInstant } from '@/utils/clock';

/**
 * Schema bookkeeping and first-run seeding.
 *
 * Two rules the legacy prototype broke:
 *
 *   1. **Migrations are explicit and run once, in a transaction.** `loadData()` mutated the
 *      record set during every page load — it re-ran the category guesser on line 1270 outside
 *      any migration flag, so derived state was recomputed on each boot and persisted only if
 *      some later action happened to call `saveData()`. Whether a record had a category
 *      depended on what the user did next.
 *
 *   2. **Migration state is one versioned value, not a scatter of boolean flags.** The
 *      prototype tracked progress with `gov_biz_migrated_v1` and `gov_group_migrated_v1` in
 *      localStorage, separate from the data they described, so clearing site data left the
 *      flags and the records out of step.
 */

export interface SeedOutcome {
  readonly seeded: boolean;
  readonly schemaVersion: number;
}

/**
 * Ensure the reference tables and singleton rows exist. Idempotent.
 * Runs inside one read-write transaction so a partial seed can never be observed.
 */
export async function ensureSeedData(db: CivicWorkDeskDatabase): Promise<SeedOutcome> {
  return db.transaction(
    'rw',
    [db.categories, db.groups, db.settings, db.meta],
    async (): Promise<SeedOutcome> => {
      const existingMeta = await db.meta.get(META_KEY);
      let seeded = false;

      if ((await db.categories.count()) === 0) {
        await db.categories.bulkAdd(defaultCategories());
        seeded = true;
      }
      if ((await db.groups.count()) === 0) {
        await db.groups.bulkAdd(defaultGroups());
        seeded = true;
      }
      if (!(await db.settings.get(SETTINGS_KEY))) {
        await db.settings.put({ key: SETTINGS_KEY, value: defaultSettings() });
        seeded = true;
      }

      if (!existingMeta) {
        await db.meta.put({
          key: META_KEY,
          value: {
            schemaVersion: SCHEMA_VERSION,
            lastBackupAt: null,
            lastBackupRecordCount: null,
            createdAt: nowInstant(),
          },
        });
        return { seeded: true, schemaVersion: SCHEMA_VERSION };
      }

      if (existingMeta.value.schemaVersion !== SCHEMA_VERSION) {
        await db.meta.put({
          key: META_KEY,
          value: { ...existingMeta.value, schemaVersion: SCHEMA_VERSION },
        });
      }
      return { seeded, schemaVersion: SCHEMA_VERSION };
    },
  );
}
