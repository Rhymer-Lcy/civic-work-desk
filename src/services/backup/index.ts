import { listRecords, readProgressEntries } from '@/db/repositories/records';
import type { InvalidRow } from '@/db/repositories/records';
import {
  getMeta,
  getSettings,
  listCategories,
  listGroups,
  recordBackupSuccess,
} from '@/db/repositories/taxonomy';
import { daysBetween, todayIso } from '@/domain/dates';
import type { AppMeta } from '@/domain/types';
import { filenameStamp, nowInstant } from '@/utils/clock';
import { downloadBlob, jsonBlob } from '../download';
import type { DownloadResult } from '../download';
import { backupFilename, buildEnvelope, serialiseEnvelope } from './envelope';
import type { BackupInput } from './envelope';
import type { BackupEnvelope } from './envelope';

export * from './envelope';
export * from './recovery';

/**
 * Backup orchestration.
 *
 * `createBackup` snapshots every table, builds the envelope, hands the blob to the browser and
 * — only then — records the success. The order matters: the legacy `exportJSON()` wrote
 * `gov_last_backup` on the same tick as `a.click()` regardless of outcome, and `exportExcel()`
 * wrote it too, so a spreadsheet export silenced the backup reminder for a week.
 */

export interface BackupResult {
  readonly download: DownloadResult;
  readonly envelope: BackupEnvelope;
  /** Ids the backup could not carry. Empty means the archive is complete. */
  readonly omitted: readonly string[];
}

/**
 * A backup snapshot, together with what it could not include.
 *
 * `omittedInvalidRowIds` is the honest part: a canonical backup can only carry rows that pass the
 * domain schema, so if the store holds a corrupt row the backup is *not* a complete archive.
 * Phase 1 dropped such rows silently and still called the result a complete backup.
 */
export interface BackupSnapshot {
  readonly input: BackupInput;
  readonly invalidRecords: readonly InvalidRow[];
  readonly invalidProgressEntries: readonly InvalidRow[];
}

export async function snapshotForBackup(): Promise<BackupInput> {
  return (await readBackupSnapshot()).input;
}

/** Read everything a backup needs, and everything it cannot include. */
export async function readBackupSnapshot(): Promise<BackupSnapshot> {
  const [recordsResult, progressResult, categories, groups, settings, meta] = await Promise.all([
    listRecords(),
    readProgressEntries(),
    listCategories(),
    listGroups(),
    getSettings(),
    getMeta(),
  ]);
  const omitted: string[] = [
    ...recordsResult.invalid.map((row: InvalidRow) => row.id),
    ...progressResult.invalid.map((row: InvalidRow) => row.id),
  ];
  return {
    input: {
      records: recordsResult.records,
      progressEntries: progressResult.entries,
      categories,
      groups,
      settings,
      omittedInvalidRowIds: omitted,
      dataRevision: meta?.dataRevision ?? null,
    },
    invalidRecords: recordsResult.invalid,
    invalidProgressEntries: progressResult.invalid,
  };
}

/**
 * Raised when a backup would silently omit stored rows.
 *
 * The user must never be told a complete backup succeeded while known rows were dropped. The
 * caller either exports a diagnostic recovery file first, or explicitly acknowledges the omission
 * — in which case the envelope itself records which ids were left out.
 */
export class IncompleteBackupError extends Error {
  override readonly name = 'IncompleteBackupError';
  readonly invalidRecordIds: readonly string[];
  readonly invalidProgressIds: readonly string[];

  constructor(invalidRecordIds: readonly string[], invalidProgressIds: readonly string[]) {
    const total = invalidRecordIds.length + invalidProgressIds.length;
    super(
      `本机有 ${String(total)} 行数据未通过校验，无法写入“完整备份”。` +
        '请先导出诊断恢复文件，或确认要导出一份不含这些行的备份。',
    );
    this.invalidRecordIds = invalidRecordIds;
    this.invalidProgressIds = invalidProgressIds;
  }
}

export interface CreateBackupOptions {
  /**
   * Proceed even though rows will be omitted. The omission is then recorded in the envelope's
   * `omittedInvalidRowIds`, so the file states plainly that it is not complete.
   */
  readonly acknowledgeOmissions?: boolean;
}

export async function createBackup(
  at: Date = new Date(),
  options: CreateBackupOptions = {},
): Promise<BackupResult> {
  const snapshot = await readBackupSnapshot();
  const omittedRecords = snapshot.invalidRecords.map((row) => row.id);
  const omittedProgress = snapshot.invalidProgressEntries.map((row) => row.id);

  if (
    (omittedRecords.length > 0 || omittedProgress.length > 0) &&
    options.acknowledgeOmissions !== true
  ) {
    throw new IncompleteBackupError(omittedRecords, omittedProgress);
  }

  const envelope = await buildEnvelope(snapshot.input, nowInstant());
  const blob = jsonBlob(serialiseEnvelope(envelope));
  const download = downloadBlob(blob, backupFilename(filenameStamp(at)));
  // Reached only if the blob was built and accepted without throwing.
  await recordBackupSuccess(envelope.counts.records);
  return { download, envelope, omitted: [...omittedRecords, ...omittedProgress] };
}

/** Why a backup is stale, so the UI can say something more useful than "old". */
export type StaleReason = 'data-changed' | 'age';

export type BackupHealth =
  | { readonly state: 'never' }
  | { readonly state: 'fresh'; readonly daysAgo: number; readonly at: string }
  | {
      readonly state: 'stale';
      readonly daysAgo: number;
      readonly at: string;
      readonly reason: StaleReason;
    }
  | { readonly state: 'unknown' };

/**
 * Backup freshness.
 *
 * Phase 1 judged this by age and record count alone, so editing an existing record left the
 * backup looking current — the count had not changed. `dataRevision` is bumped by every
 * successfully persisted user-data mutation (see `withMutation`), and a canonical backup records
 * the revision it captured, so **any** divergence is detectable: an edit, a soft delete, a
 * category rename, a settings change.
 *
 * `emptyStore` still suppresses the warning entirely: nagging about backing up nothing was one of
 * the legacy prototype's noisier behaviours, and its "fix" there was to hard-hide the banner on
 * every load, which disabled the warning permanently.
 */
export function assessBackupHealth(
  meta: AppMeta | null,
  currentRecordCount: number,
  reminderDays: number,
  today: string = todayIso(),
): BackupHealth {
  if (currentRecordCount === 0) return { state: 'fresh', daysAgo: 0, at: today };
  if (!meta) return { state: 'unknown' };
  if (meta.lastBackupAt === null) return { state: 'never' };

  const at = meta.lastBackupAt;
  const day = at.slice(0, 10);
  let daysAgo: number;
  try {
    daysAgo = Math.max(0, daysBetween(day, today));
  } catch {
    return { state: 'unknown' };
  }

  // The data has changed since the backup was taken. This is the authoritative signal.
  const diverged =
    meta.lastBackupRevision === null || meta.dataRevision !== meta.lastBackupRevision;
  if (diverged) return { state: 'stale', daysAgo, at, reason: 'data-changed' };

  // Unchanged data, but the backup is old enough that the file itself may have been lost.
  if (daysAgo >= reminderDays) return { state: 'stale', daysAgo, at, reason: 'age' };

  return { state: 'fresh', daysAgo, at };
}

export function describeBackupHealth(health: BackupHealth): string {
  switch (health.state) {
    case 'never':
      return '尚未导出过 JSON 备份。';
    case 'stale':
      return health.reason === 'data-changed'
        ? `上次备份（${health.at.slice(0, 10)}）之后数据已有改动，建议现在重新导出。`
        : `上次备份在 ${health.daysAgo} 天前（${health.at.slice(0, 10)}），建议现在导出。`;
    case 'fresh':
      return health.daysAgo === 0 ? '今天已备份。' : `上次备份在 ${health.daysAgo} 天前。`;
    case 'unknown':
      return '备份状态未知。';
  }
}

/** Read a user-selected file as text, rejecting anything implausibly large. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export async function readBackupFile(file: File): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`文件过大（${Math.round(file.size / 1024 / 1024)} MB），已拒绝读取。`);
  }
  return file.text();
}
