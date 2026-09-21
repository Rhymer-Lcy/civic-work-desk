import { readStoreSnapshot, allInvalidRows, invalidRowCount } from '@/db/snapshot';
import { validateRelationalIntegrity } from '@/domain/integrity';
import type { IntegrityIssue } from '@/domain/integrity';
import type { InvalidEntityGroups } from '@/db/snapshot';
import type { InvalidRow } from '@/db/invalid-row';
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
 * they sit in IndexedDB, for technical recovery and as evidence. Since Phase 1.2 it covers **every**
 * user-data store — records, progress entries, categories, groups and the settings row — because
 * Phase 1.1 only closed the first two, leaving corrupt taxonomy to be dropped by `listCategories()`
 * and a corrupt settings row to be replaced by `defaultSettings()` with nothing recorded anywhere.
 *
 * **It is deliberately NOT importable.** Its `application` field does not match the canonical
 * backup id, so `detectSource()` refuses it rather than half-restoring broken data. Recovering
 * from it is a manual, technical act.
 */

export const RECOVERY_APP_ID = 'civic-work-desk-diagnostic-recovery';
export const RECOVERY_FORMAT_VERSION = 2;

export interface RecoveryCounts {
  readonly validRecords: number;
  readonly invalidRecords: number;
  readonly validProgressEntries: number;
  readonly invalidProgressEntries: number;
  readonly validCategories: number;
  readonly invalidCategories: number;
  readonly validGroups: number;
  readonly invalidGroups: number;
  /** 1 when the stored settings row validated, 0 when it is missing or corrupt. */
  readonly validSettings: number;
  readonly invalidSettings: number;
  readonly invalidTotal: number;
  /** Relational defects between otherwise valid rows: orphans, dangling references, duplicate ids. */
  readonly relationalIssues: number;
}

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
  readonly counts: RecoveryCounts;
  /** The rows that failed validation, verbatim, with the error that rejected them. */
  readonly invalidRecords: readonly InvalidRow[];
  readonly invalidProgressEntries: readonly InvalidRow[];
  readonly invalidCategories: readonly InvalidRow[];
  readonly invalidGroups: readonly InvalidRow[];
  /** Zero or one entry: the stored settings row, raw, when it did not validate. */
  readonly invalidSettings: readonly InvalidRow[];
  /**
   * Relational defects, structured rather than prose.
   *
   * A row can be perfectly valid on its own and still belong to a broken state — an honour pointing at
   * a purged work record, a progress note whose record is gone. Those never appear in the invalid-row
   * lists above, because nothing about the row itself is wrong, so the recovery file records them
   * separately with their kind, the offending id and the reference that failed to resolve.
   */
  readonly relationalIssues: readonly IntegrityIssue[];
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
  readonly invalid: InvalidEntityGroups;
  readonly invalidRecords: readonly InvalidRow[];
  readonly invalidProgressEntries: readonly InvalidRow[];
  readonly invalidCategories: readonly InvalidRow[];
  readonly invalidGroups: readonly InvalidRow[];
  readonly invalidSettings: readonly InvalidRow[];
  readonly validRecordCount: number;
  readonly validProgressCount: number;
  readonly invalidTotal: number;
  readonly relationalIssues: readonly IntegrityIssue[];
}

/** Read everything the recovery export needs, including the rows a backup cannot carry. */
export async function readRecoverySnapshot(): Promise<RecoverySnapshot> {
  const snapshot = await readStoreSnapshot();
  return {
    invalid: snapshot.invalid,
    invalidRecords: snapshot.invalid.records,
    invalidProgressEntries: snapshot.invalid.progressEntries,
    invalidCategories: snapshot.invalid.categories,
    invalidGroups: snapshot.invalid.groups,
    invalidSettings: snapshot.invalid.settings,
    validRecordCount: snapshot.records.length,
    validProgressCount: snapshot.progressEntries.length,
    invalidTotal: invalidRowCount(snapshot.invalid),
    relationalIssues: relationalIssuesOf(snapshot),
  };
}

/** Relational defects of a store snapshot, by the shared domain rules. */
function relationalIssuesOf(snapshot: {
  readonly records: Parameters<typeof validateRelationalIntegrity>[0]['records'];
  readonly progressEntries: Parameters<typeof validateRelationalIntegrity>[0]['progressEntries'];
  readonly categories: Parameters<typeof validateRelationalIntegrity>[0]['categories'];
  readonly groups: Parameters<typeof validateRelationalIntegrity>[0]['groups'];
}): IntegrityIssue[] {
  return validateRelationalIntegrity({
    records: snapshot.records,
    progressEntries: snapshot.progressEntries,
    categories: snapshot.categories,
    groups: snapshot.groups,
  });
}

export async function buildRecoveryExport(exportedAt: string): Promise<RecoveryExport> {
  const snapshot = await readStoreSnapshot();
  const invalid = snapshot.invalid;
  const relationalIssues = relationalIssuesOf(snapshot);

  // The digest covers every raw invalid row, so a recovery file that was truncated or edited after
  // the fact is detectable. It is corruption detection, not authentication.
  const body = {
    invalidRecords: invalid.records,
    invalidProgressEntries: invalid.progressEntries,
    invalidCategories: invalid.categories,
    invalidGroups: invalid.groups,
    invalidSettings: invalid.settings,
    relationalIssues,
  };

  return {
    application: RECOVERY_APP_ID,
    recoveryFormatVersion: RECOVERY_FORMAT_VERSION,
    restorable: false,
    note:
      '这是诊断恢复文件，不是备份，不能通过“导入 / 还原备份”写回应用。' +
      '它按原样保留了未通过校验的数据行（记录、进展、业务分类、归属分组与应用设置），' +
      '供技术排查与留证使用。',
    exportedAt,
    schemaVersion: SCHEMA_VERSION,
    canonicalBackupFormatVersion: BACKUP_FORMAT_VERSION,
    dataRevision: snapshot.capturedRevision,
    counts: {
      validRecords: snapshot.records.length,
      invalidRecords: invalid.records.length,
      validProgressEntries: snapshot.progressEntries.length,
      invalidProgressEntries: invalid.progressEntries.length,
      validCategories: snapshot.categories.length,
      invalidCategories: invalid.categories.length,
      validGroups: snapshot.groups.length,
      invalidGroups: invalid.groups.length,
      validSettings: snapshot.settings === null ? 0 : 1,
      invalidSettings: invalid.settings.length,
      invalidTotal: invalidRowCount(invalid),
      relationalIssues: relationalIssues.length,
    },
    invalidRecords: invalid.records,
    invalidProgressEntries: invalid.progressEntries,
    invalidCategories: invalid.categories,
    invalidGroups: invalid.groups,
    invalidSettings: invalid.settings,
    relationalIssues,
    context: {
      validRecordIds: snapshot.records.map((record) => record.id),
      categories: snapshot.categories.map((category) => ({ id: category.id, name: category.name })),
      groups: snapshot.groups.map((group) => ({ id: group.id, name: group.name })),
      // The valid stored settings, or null. Never the defaults: substituting them here would hide
      // the very corruption this file exists to preserve.
      settings: snapshot.settings,
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
  readonly invalidCategories: number;
  readonly invalidGroups: number;
  readonly invalidSettings: number;
  readonly invalidTotal: number;
}

/**
 * Write the recovery file.
 *
 * Never touches canonical backup bookkeeping: this file cannot restore anything, so treating it as
 * a backup would suppress the reminder exactly when the database is known to be damaged.
 */
export async function createRecoveryExport(at: Date = new Date()): Promise<RecoveryResult> {
  const payload = await buildRecoveryExport(nowInstant());
  const blob = jsonBlob(`${JSON.stringify(payload, null, 2)}\n`);
  const download = downloadBlob(blob, recoveryFilename(filenameStamp(at)));
  return {
    download,
    invalidRecords: payload.counts.invalidRecords,
    invalidProgressEntries: payload.counts.invalidProgressEntries,
    invalidCategories: payload.counts.invalidCategories,
    invalidGroups: payload.counts.invalidGroups,
    invalidSettings: payload.counts.invalidSettings,
    invalidTotal: payload.counts.invalidTotal,
  };
}

/** Re-exported so callers can enumerate every invalid row without importing the db layer. */
export { allInvalidRows };
