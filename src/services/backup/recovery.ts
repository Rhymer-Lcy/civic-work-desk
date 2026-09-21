import { listRecords, readProgressEntries } from '@/db/repositories/records';
import type { InvalidRow } from '@/db/repositories/records';
import { getMeta, listCategories, listGroups, getSettings } from '@/db/repositories/taxonomy';
import { SCHEMA_VERSION } from '@/db/schema';
import { filenameStamp, nowInstant } from '@/utils/clock';
import { downloadBlob, jsonBlob } from '../download';
import type { DownloadResult } from '../download';
import { BACKUP_APP_ID, canonicalJson, sha256Hex } from './envelope';
import { BACKUP_FORMAT_VERSION } from './compatibility';

/**
 * Diagnostic recovery export.
 *
 * A canonical backup is strictly restorable: every row in it has passed the domain schema, so the
 * importer can write it back without inventing anything. That guarantee has a consequence — a
 * stored row that fails validation **cannot** go into a canonical backup.
 *
 * Phase 1 resolved that silently: `snapshotForBackup()` took only the valid records, so a corrupt
 * row vanished from a file the UI called a complete backup, while the Diagnostics panel was
 * simultaneously telling the user to export a JSON backup as evidence before restoring. The two
 * behaviours contradicted each other and the user was never told.
 *
 * This file is the other half of the fix: a separate export that preserves the raw rows exactly as
 * they sit in IndexedDB, for technical recovery and as evidence.
 *
 * **It is deliberately NOT importable.** Its `application` field does not match the canonical
 * backup id, so `detectSource()` refuses it rather than half-restoring broken data. Recovering
 * from it is a manual, technical act.
 */

export const RECOVERY_APP_ID = 'civic-work-desk-diagnostic-recovery';
export const RECOVERY_FORMAT_VERSION = 1;

export interface RecoveryExport {
  readonly application: typeof RECOVERY_APP_ID;
  readonly recoveryFormatVersion: number;
  /** Stated prominently: this file is evidence, not a restore source. */
  readonly restorable: false;
  readonly note: string;
  readonly exportedAt: string;
  readonly schemaVersion: number;
  readonly canonicalBackupFormatVersion: number;
  readonly dataRevision: number | null;
  readonly counts: {
    readonly validRecords: number;
    readonly invalidRecords: number;
    readonly validProgressEntries: number;
    readonly invalidProgressEntries: number;
  };
  /** The rows that failed validation, verbatim, with the error that rejected them. */
  readonly invalidRecords: readonly InvalidRow[];
  readonly invalidProgressEntries: readonly InvalidRow[];
  /**
   * Context needed to make sense of the broken rows: which categories and groups they may
   * reference, and the ids of the rows that were fine.
   */
  readonly context: {
    readonly validRecordIds: readonly string[];
    readonly categories: readonly { readonly id: string; readonly name: string }[];
    readonly groups: readonly { readonly id: string; readonly name: string }[];
    readonly settings: unknown;
  };
  readonly rawChecksum: string | null;
}

export interface RecoverySnapshot {
  readonly invalidRecords: readonly InvalidRow[];
  readonly invalidProgressEntries: readonly InvalidRow[];
  readonly validRecordCount: number;
  readonly validProgressCount: number;
}

/** Read everything the recovery export needs, including the rows a backup cannot carry. */
export async function readRecoverySnapshot(): Promise<RecoverySnapshot> {
  const [records, progress] = await Promise.all([listRecords(), readProgressEntries()]);
  return {
    invalidRecords: records.invalid,
    invalidProgressEntries: progress.invalid,
    validRecordCount: records.records.length,
    validProgressCount: progress.entries.length,
  };
}

export async function buildRecoveryExport(exportedAt: string): Promise<RecoveryExport> {
  const [records, progress, categories, groups, settings, meta] = await Promise.all([
    listRecords(),
    readProgressEntries(),
    listCategories(),
    listGroups(),
    getSettings(),
    getMeta(),
  ]);

  const body = {
    invalidRecords: records.invalid,
    invalidProgressEntries: progress.invalid,
  };

  return {
    application: RECOVERY_APP_ID,
    recoveryFormatVersion: RECOVERY_FORMAT_VERSION,
    restorable: false,
    note:
      '这是诊断恢复文件，不是备份，不能通过“导入 / 还原备份”写回应用。' +
      '它按原样保留了未通过校验的数据行，供技术排查与留证使用。',
    exportedAt,
    schemaVersion: SCHEMA_VERSION,
    canonicalBackupFormatVersion: BACKUP_FORMAT_VERSION,
    dataRevision: meta?.dataRevision ?? null,
    counts: {
      validRecords: records.records.length,
      invalidRecords: records.invalid.length,
      validProgressEntries: progress.entries.length,
      invalidProgressEntries: progress.invalid.length,
    },
    invalidRecords: records.invalid,
    invalidProgressEntries: progress.invalid,
    context: {
      validRecordIds: records.records.map((record) => record.id),
      categories: categories.map((category) => ({ id: category.id, name: category.name })),
      groups: groups.map((group) => ({ id: group.id, name: group.name })),
      settings,
    },
    rawChecksum: await sha256Hex(canonicalJson(body)),
  };
}

export function recoveryFilename(stamp: string): string {
  return `${BACKUP_APP_ID}-recovery-${stamp}.json`;
}

export interface RecoveryResult {
  readonly download: DownloadResult;
  readonly invalidRecords: number;
  readonly invalidProgressEntries: number;
}

export async function createRecoveryExport(at: Date = new Date()): Promise<RecoveryResult> {
  const payload = await buildRecoveryExport(nowInstant());
  const blob = jsonBlob(`${JSON.stringify(payload, null, 2)}\n`);
  const download = downloadBlob(blob, recoveryFilename(filenameStamp(at)));
  return {
    download,
    invalidRecords: payload.counts.invalidRecords,
    invalidProgressEntries: payload.counts.invalidProgressEntries,
  };
}
