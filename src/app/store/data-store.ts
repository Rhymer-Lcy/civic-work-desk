import { createContext, useContext, useMemo } from 'react';
import { getMeta } from '@/db/repositories/taxonomy';
import { EMPTY_INVALID, invalidRowCount, readStoreSnapshot } from '@/db/snapshot';
import type { InvalidEntityGroups } from '@/db/snapshot';
import { todayIso } from '@/domain/dates';
import { defaultSettings } from '@/domain/defaults';
import type {
  AnyRecord,
  AppMeta,
  AppSettings,
  BusinessCategory,
  ProgressEntry,
  WorkGroup,
} from '@/domain/types';
import { assessBackupHealth } from '@/services/backup';
import type { BackupHealth } from '@/services/backup';

/**
 * The single application snapshot.
 *
 * Every view reads from here and every mutation calls `refresh()`. Deliberately simple: this is a
 * personal work log of hundreds of records, so re-reading the tables after a write is
 * imperceptible and removes a whole class of cache-coherence bugs. What it buys is the guarantee
 * the legacy prototype lacked — no view can hold a stale copy of a record or compute counts from
 * a different snapshot than the list beside it.
 */

export interface DataSnapshot {
  readonly records: readonly AnyRecord[];
  readonly progress: readonly ProgressEntry[];
  readonly progressCountByRecord: ReadonlyMap<string, number>;
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly settings: AppSettings;
  readonly meta: AppMeta | null;
  readonly backupHealth: BackupHealth;
  /**
   * Rows that failed schema validation, per store. Surfaced in Settings, never hidden.
   *
   * Phase 1.1 carried only record-level failures here, because `listCategories()`,
   * `listGroups()` and `getSettings()` filtered or defaulted their failures away before anything
   * could see them. Diagnostics could therefore say 全部记录通过结构校验 while a category row was
   * corrupt and a canonical backup was quietly dropping it.
   */
  readonly integrity: InvalidEntityGroups;
  /** True when a complete canonical backup is currently possible. */
  readonly storeIntact: boolean;
  /** Today's business date, resolved once per load so all views agree. */
  readonly today: string;
}

export type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: DataSnapshot }
  | { readonly status: 'error'; readonly error: Error };

export interface DataContextValue {
  readonly state: LoadState;
  readonly refresh: () => Promise<void>;
}

export const DataContext = createContext<DataContextValue | null>(null);

/**
 * Load the whole application state.
 *
 * One `readStoreSnapshot()` rather than six parallel repository reads: every view then shows a
 * state the database actually had at one instant, and the integrity report beside the data
 * describes the same read. `meta` is fetched separately because it is installation bookkeeping, not
 * user data, and is the one value a later write (a backup stamp) may legitimately change without
 * the views being stale.
 */
export async function loadSnapshot(): Promise<DataSnapshot> {
  const [snapshot, meta] = await Promise.all([readStoreSnapshot(), getMeta()]);
  const settings = snapshot.settings ?? defaultSettings();
  const counts = new Map<string, number>();
  for (const entry of snapshot.progressEntries) {
    counts.set(entry.recordId, (counts.get(entry.recordId) ?? 0) + 1);
  }
  const live = snapshot.records.filter((record) => record.deletedAt === null);
  const today = todayIso();
  return {
    records: snapshot.records,
    progress: snapshot.progressEntries,
    progressCountByRecord: counts,
    categories: snapshot.categories,
    groups: snapshot.groups,
    // The UI must stay operable, so corrupt settings fall back to the defaults *here* — and the
    // corruption travels alongside in `integrity` rather than disappearing.
    settings,
    meta,
    backupHealth: assessBackupHealth(meta, live.length, settings.backupReminderDays, today),
    integrity: snapshot.invalid,
    storeIntact: invalidRowCount(snapshot.invalid) === 0 && snapshot.settings !== null,
    today,
  };
}

export function useDataContext(): DataContextValue {
  const context = useContext(DataContext);
  if (!context) throw new Error('useDataContext must be used inside <DataProvider>');
  return context;
}

/**
 * Snapshot accessor for views that require data.
 *
 * Returns a safe empty snapshot while loading so a view never has to branch on load state for
 * every field. Views that need to show a spinner read `useDataContext().state.status`.
 */
export function useData(): DataSnapshot {
  const { state } = useDataContext();
  return useMemo<DataSnapshot>(() => {
    if (state.status === 'ready') return state.data;
    return {
      records: [],
      progress: [],
      progressCountByRecord: new Map(),
      categories: [],
      groups: [],
      settings: defaultSettings(),
      meta: null,
      backupHealth: { state: 'unknown' },
      integrity: EMPTY_INVALID,
      storeIntact: true,
      today: todayIso(),
    };
  }, [state]);
}

export function useRefresh(): () => Promise<void> {
  return useDataContext().refresh;
}
