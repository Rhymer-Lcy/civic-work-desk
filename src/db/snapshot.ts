import type {
  AnyRecord,
  AppSettings,
  BusinessCategory,
  ProgressEntry,
  WorkGroup,
} from '@/domain/types';
import {
  anyRecordSchema,
  appSettingsSchema,
  businessCategorySchema,
  progressEntrySchema,
  workGroupSchema,
} from '@/domain/validation';
import { withDatabase } from './client';
import { META_KEY, SETTINGS_KEY } from './schema';
import { SETTINGS_ROW_ID, partitionRows } from './invalid-row';
import type { InvalidRow, ParseOutcome } from './invalid-row';

/**
 * The canonical store snapshot: one coherent view of every user-data store.
 *
 * **Why one transaction.** Phase 1.1 built a backup from six independent repository reads issued
 * through `Promise.all`. Each one is its own IndexedDB transaction, so the archive described records
 * as they were at one instant, categories as they were at another, and `meta.dataRevision` at a
 * third. Nothing detected the difference, and the file claimed to be a snapshot of a database state
 * that had never simultaneously existed. A concurrent write in another tab — or the user typing
 * while the export ran — was enough to produce it.
 *
 * Everything here happens inside a single Dexie read-only transaction over all six stores:
 *
 *   records · progressEntries · categories · groups · settings · meta
 *
 * Inside that boundary the rows are read raw, validated, partitioned into valid values and invalid
 * rows, and `meta.dataRevision` is captured. The revision is therefore **the revision this snapshot
 * contains**, which is what makes honest freshness accounting possible (see
 * `recordCanonicalBackup`).
 *
 * **Why validation happens here and not in the repositories.** The repositories are free to keep
 * their convenient shapes (a list of valid categories, a settings object with defaults) because the
 * UI must stay operable in the presence of corruption. What must not happen is a *backup* built
 * from those convenient shapes: that is how corruption became silent absence in Phase 1.1.
 */

export interface InvalidEntityGroups {
  readonly records: readonly InvalidRow[];
  readonly progressEntries: readonly InvalidRow[];
  readonly categories: readonly InvalidRow[];
  readonly groups: readonly InvalidRow[];
  /** Zero or one entry. An array keeps the shape uniform for counting and rendering. */
  readonly settings: readonly InvalidRow[];
}

export interface StoreSnapshot {
  readonly records: readonly AnyRecord[];
  readonly progressEntries: readonly ProgressEntry[];
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  /**
   * The stored settings, or `null` when the row is missing or does not validate.
   *
   * Null is deliberately not "the defaults". A caller that needs something usable substitutes them
   * knowingly; a caller building a backup must treat null as an omission.
   */
  readonly settings: AppSettings | null;
  readonly invalid: InvalidEntityGroups;
  /** `meta.dataRevision` as observed inside the snapshot transaction. */
  readonly capturedRevision: number | null;
}

export const EMPTY_INVALID: InvalidEntityGroups = Object.freeze({
  records: Object.freeze([]),
  progressEntries: Object.freeze([]),
  categories: Object.freeze([]),
  groups: Object.freeze([]),
  settings: Object.freeze([]),
});

function firstIssue(error: { issues: readonly { message?: string }[] }): string {
  return error.issues[0]?.message ?? 'schema mismatch';
}

const parseRecord = (row: unknown): ParseOutcome<AnyRecord> => {
  const parsed = anyRecordSchema.safeParse(row);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: firstIssue(parsed.error) };
};

const parseProgress = (row: unknown): ParseOutcome<ProgressEntry> => {
  const parsed = progressEntrySchema.safeParse(row);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: firstIssue(parsed.error) };
};

const parseCategory = (row: unknown): ParseOutcome<BusinessCategory> => {
  const parsed = businessCategorySchema.safeParse(row);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: firstIssue(parsed.error) };
};

const parseGroup = (row: unknown): ParseOutcome<WorkGroup> => {
  const parsed = workGroupSchema.safeParse(row);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: firstIssue(parsed.error) };
};

/**
 * Read every user-data store in one read-only transaction and validate as it goes.
 *
 * The transaction scope is stated explicitly rather than derived, so the boundary is visible at the
 * call site and asserted by a test.
 */
export async function readStoreSnapshot(): Promise<StoreSnapshot> {
  return withDatabase('readStoreSnapshot', (db) =>
    db.transaction(
      'r',
      [db.records, db.progressEntries, db.categories, db.groups, db.settings, db.meta],
      async (): Promise<StoreSnapshot> => {
        const [rawRecords, rawProgress, rawCategories, rawGroups, settingsRow, metaRow] =
          await Promise.all([
            db.records.toArray(),
            db.progressEntries.toArray(),
            db.categories.toArray(),
            db.groups.toArray(),
            db.settings.get(SETTINGS_KEY),
            db.meta.get(META_KEY),
          ]);

        const records = partitionRows(rawRecords, parseRecord);
        const progress = partitionRows(rawProgress, parseProgress);
        const categories = partitionRows(rawCategories, parseCategory);
        const groups = partitionRows(rawGroups, parseGroup);

        /*
         * Settings are a singleton, so "corrupt" and "missing" are both integrity problems for a
         * backup: neither tells us what the user's settings were. `ensureSeedData` writes the row on
         * first run and the wipe path re-seeds immediately, so absence in a live store means
         * something removed it.
         */
        let settings: AppSettings | null = null;
        const invalidSettings: InvalidRow[] = [];
        if (!settingsRow) {
          invalidSettings.push({
            id: SETTINGS_ROW_ID,
            reason: '设置行缺失：本机没有存储任何应用设置',
            raw: null,
          });
        } else {
          const parsed = appSettingsSchema.safeParse(settingsRow.value);
          if (parsed.success) settings = parsed.data;
          else {
            invalidSettings.push({
              id: SETTINGS_ROW_ID,
              reason: firstIssue(parsed.error),
              raw: settingsRow.value,
            });
          }
        }

        // Presentation order is the stores' own, so a backup and a recovery export agree.
        categories.valid.sort((a, b) => a.sortOrder - b.sortOrder);
        groups.valid.sort((a, b) => a.sortOrder - b.sortOrder);
        progress.valid.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        return {
          records: records.valid,
          progressEntries: progress.valid,
          categories: categories.valid,
          groups: groups.valid,
          settings,
          invalid: {
            records: records.invalid,
            progressEntries: progress.invalid,
            categories: categories.invalid,
            groups: groups.invalid,
            settings: invalidSettings,
          },
          capturedRevision: metaRow?.value.dataRevision ?? null,
        };
      },
    ),
  );
}

/** Every invalid row across every store, in a stable order. */
export function allInvalidRows(invalid: InvalidEntityGroups): readonly InvalidRow[] {
  return [
    ...invalid.records,
    ...invalid.progressEntries,
    ...invalid.categories,
    ...invalid.groups,
    ...invalid.settings,
  ];
}

export function invalidRowCount(invalid: InvalidEntityGroups): number {
  return allInvalidRows(invalid).length;
}

/**
 * True when nothing in the database failed validation.
 *
 * This is the single definition of "a complete canonical backup is possible". Anything that reports
 * completeness — the envelope, the import preview, backup freshness — derives from it.
 */
export function storeIsIntact(snapshot: StoreSnapshot): boolean {
  return invalidRowCount(snapshot.invalid) === 0 && snapshot.settings !== null;
}
