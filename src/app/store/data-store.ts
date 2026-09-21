import { createContext, useContext, useMemo } from 'react';
import { listProgressEntries, listRecords, progressCounts } from '@/db/repositories/records';
import { getMeta, getSettings, listCategories, listGroups } from '@/db/repositories/taxonomy';
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
  /** Rows in the store that failed schema validation. Surfaced in Settings, never hidden. */
  readonly invalidRows: readonly { readonly id: string; readonly reason: string }[];
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

export async function loadSnapshot(): Promise<DataSnapshot> {
  const [recordsResult, progress, counts, categories, groups, settings, meta] = await Promise.all([
    listRecords(),
    listProgressEntries(),
    progressCounts(),
    listCategories(),
    listGroups(),
    getSettings(),
    getMeta(),
  ]);
  const live = recordsResult.records.filter((record) => record.deletedAt === null);
  const today = todayIso();
  return {
    records: recordsResult.records,
    progress,
    progressCountByRecord: counts,
    categories,
    groups,
    settings,
    meta,
    backupHealth: assessBackupHealth(meta, live.length, settings.backupReminderDays, today),
    invalidRows: recordsResult.invalid,
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
      invalidRows: [],
      today: todayIso(),
    };
  }, [state]);
}

export function useRefresh(): () => Promise<void> {
  return useDataContext().refresh;
}
