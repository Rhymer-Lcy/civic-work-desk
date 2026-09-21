import { listProgressEntries, listRecords } from '@/db/repositories/records';
import {
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
import type { BackupEnvelope } from './envelope';

export * from './envelope';

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
}

export async function snapshotForBackup(): Promise<Parameters<typeof buildEnvelope>[0]> {
  const [{ records }, progressEntries, categories, groups, settings] = await Promise.all([
    listRecords(),
    listProgressEntries(),
    listCategories(),
    listGroups(),
    getSettings(),
  ]);
  return { records, progressEntries, categories, groups, settings };
}

export async function createBackup(at: Date = new Date()): Promise<BackupResult> {
  const snapshot = await snapshotForBackup();
  const envelope = await buildEnvelope(snapshot, nowInstant());
  const blob = jsonBlob(serialiseEnvelope(envelope));
  const download = downloadBlob(blob, backupFilename(filenameStamp(at)));
  // Reached only if the blob was built and accepted without throwing.
  await recordBackupSuccess(envelope.counts.records);
  return { download, envelope };
}

export type BackupHealth =
  | { readonly state: 'never' }
  | { readonly state: 'fresh'; readonly daysAgo: number; readonly at: string }
  | { readonly state: 'stale'; readonly daysAgo: number; readonly at: string }
  | { readonly state: 'unknown' };

/**
 * Backup freshness.
 *
 * `recordCount` is compared so "backed up 2 days ago" is not reassuring when 40 records have been
 * added since. `emptyStore` suppresses the warning entirely: nagging about backing up nothing was
 * one of the legacy prototype's noisier behaviours, and its fix there was to hard-hide the banner
 * on every load (line 3563), which disabled the warning permanently.
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

  const grew =
    meta.lastBackupRecordCount !== null && currentRecordCount > meta.lastBackupRecordCount;
  const overdue = daysAgo >= reminderDays;
  return overdue || (grew && daysAgo >= 1)
    ? { state: 'stale', daysAgo, at }
    : { state: 'fresh', daysAgo, at };
}

export function describeBackupHealth(health: BackupHealth): string {
  switch (health.state) {
    case 'never':
      return '尚未导出过 JSON 备份。';
    case 'stale':
      return `上次备份在 ${health.daysAgo} 天前（${health.at.slice(0, 10)}），建议现在导出。`;
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
