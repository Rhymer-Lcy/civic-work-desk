import { readStoreSnapshot, allInvalidRows, invalidRowCount, storeIsIntact } from '@/db/snapshot';
import type { InvalidEntityGroups, StoreSnapshot } from '@/db/snapshot';
import type { InvalidRow } from '@/db/invalid-row';
import { recordCanonicalBackup } from '@/db/repositories/taxonomy';
import { businessDateOf, daysBetween, todayIso } from '@/domain/dates';
import { describeIntegrityIssues, validateRelationalIntegrity } from '@/domain/integrity';
import type { IntegrityIssue } from '@/domain/integrity';
import { defaultSettings } from '@/domain/defaults';
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
 * `createBackup` takes one coherent snapshot of every store, builds the envelope, hands the blob to
 * the browser and — only then, and only if the snapshot was complete — records the success. The
 * order matters: the legacy `exportJSON()` wrote `gov_last_backup` on the same tick as `a.click()`
 * regardless of outcome, and `exportExcel()` wrote it too, so a spreadsheet export silenced the
 * backup reminder for a week.
 */

export interface BackupResult {
  readonly download: DownloadResult;
  readonly envelope: BackupEnvelope;
  /** Ids the backup could not carry. Empty means the archive is complete. */
  readonly omitted: readonly string[];
  /** True when this export established canonical backup freshness. */
  readonly markedFresh: boolean;
}

/**
 * A backup snapshot, together with what it could not include.
 *
 * Built from one read-only transaction over every user-data store (`readStoreSnapshot`), so the
 * archive describes a database state that actually existed at one instant, and `capturedRevision`
 * is the revision it contains rather than whatever the counter reads when the export finishes.
 */
export interface BackupSnapshot {
  readonly input: BackupInput;
  readonly invalid: InvalidEntityGroups;
  /**
   * Relational defects in the live store: orphan progress, dangling references, duplicate ids.
   *
   * Schema validity is per row; this is the property *between* rows, and it is what decides whether
   * the archive could be restored. Phase 1.2 checked it only at restore time, so the application
   * could produce a "complete" backup it would then refuse to accept.
   */
  readonly relationalIssues: readonly IntegrityIssue[];
  readonly capturedRevision: number | null;
  /**
   * True when a **complete, restorable** canonical backup is possible: every row validates *and* the
   * relationships between them resolve.
   */
  readonly complete: boolean;
  /** Kept for callers that only care about these two stores. */
  readonly invalidRecords: readonly InvalidRow[];
  readonly invalidProgressEntries: readonly InvalidRow[];
}

export async function snapshotForBackup(): Promise<BackupInput> {
  return (await readBackupSnapshot()).input;
}

/**
 * Read everything a backup needs, and everything it cannot include.
 *
 * Settings deserve a note. When the stored settings row is missing or corrupt the snapshot carries
 * `null`, and this function substitutes the defaults **and records the omission** — the payload must
 * still validate, but the file must not pretend those were the user's settings. Phase 1.1 called
 * `getSettings()`, which silently returned the defaults, so a corrupt settings row produced a
 * "complete" backup of settings the user had never chosen.
 */
export async function readBackupSnapshot(): Promise<BackupSnapshot> {
  const snapshot: StoreSnapshot = await readStoreSnapshot();
  const omitted = allInvalidRows(snapshot.invalid).map((row) => row.id);

  /*
   * Relational validity of the live store, judged by the same domain rules a canonical restore
   * applies. This is the closure of the Phase-1.2 gap: the file is only allowed to call itself
   * complete when restoring it would actually work.
   *
   * Validated over the *valid* rows, which is the set the archive would carry. A store that also has
   * invalid rows is already incomplete for a different reason, and both are reported.
   */
  const relationalIssues = validateRelationalIntegrity({
    records: snapshot.records,
    progressEntries: snapshot.progressEntries,
    categories: snapshot.categories,
    groups: snapshot.groups,
  });

  return {
    input: {
      records: snapshot.records,
      progressEntries: snapshot.progressEntries,
      categories: snapshot.categories,
      groups: snapshot.groups,
      settings: snapshot.settings ?? defaultSettings(),
      omittedInvalidRowIds: omitted,
      dataRevision: snapshot.capturedRevision,
    },
    invalid: snapshot.invalid,
    relationalIssues,
    capturedRevision: snapshot.capturedRevision,
    complete: storeIsIntact(snapshot) && relationalIssues.length === 0,
    invalidRecords: snapshot.invalid.records,
    invalidProgressEntries: snapshot.invalid.progressEntries,
  };
}

/**
 * Raised when the live store is relationally broken, so no canonical backup can be produced.
 *
 * Deliberately **not acknowledgeable**, unlike `IncompleteBackupError`. An "incomplete" envelope must
 * carry omission evidence (`omittedInvalidRowIds`), and relational damage produces none — every row
 * validates. Writing such a file would mean either labelling it complete (a lie the digest would then
 * protect) or inventing an omission list. Blocking is the only honest outcome, and the diagnostic
 * recovery export remains available as evidence.
 */
export class RelationalIntegrityError extends Error {
  override readonly name = 'RelationalIntegrityError';
  readonly issues: readonly IntegrityIssue[];

  constructor(issues: readonly IntegrityIssue[]) {
    super(
      `本机数据的关联关系不自洽（${String(issues.length)} 处），无法生成可还原的完整备份：` +
        `${describeIntegrityIssues(issues, 'store').join('；')}。` +
        '请先导出诊断恢复文件留证，再从一份已知良好的备份还原。',
    );
    this.issues = issues;
  }
}

/**
 * Raised when a backup would silently omit stored rows.
 *
 * The user must never be told a complete backup succeeded while known rows were dropped. The
 * caller either exports a diagnostic recovery file first, or explicitly acknowledges the omission
 * — in which case the envelope itself records which ids were left out, declares itself incomplete,
 * and can never afterwards be used as the source of an exact restore.
 */
export class IncompleteBackupError extends Error {
  override readonly name = 'IncompleteBackupError';
  readonly invalidRecordIds: readonly string[];
  readonly invalidProgressIds: readonly string[];
  /** Every invalid row across every store, so the caller can explain what is wrong where. */
  readonly invalid: InvalidEntityGroups;

  constructor(invalid: InvalidEntityGroups) {
    const total = invalidRowCount(invalid);
    const where = [
      invalid.records.length > 0 ? `记录 ${String(invalid.records.length)}` : null,
      invalid.progressEntries.length > 0 ? `进展 ${String(invalid.progressEntries.length)}` : null,
      invalid.categories.length > 0 ? `业务分类 ${String(invalid.categories.length)}` : null,
      invalid.groups.length > 0 ? `归属分组 ${String(invalid.groups.length)}` : null,
      invalid.settings.length > 0 ? '应用设置' : null,
    ].filter((part): part is string => part !== null);
    super(
      `本机有 ${String(total)} 行数据未通过校验（${where.join('、')}），无法写入“完整备份”。` +
        '请先导出诊断恢复文件，或确认要导出一份不含这些行的备份。',
    );
    this.invalid = invalid;
    this.invalidRecordIds = invalid.records.map((row) => row.id);
    this.invalidProgressIds = invalid.progressEntries.map((row) => row.id);
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
  const omitted = allInvalidRows(snapshot.invalid).map((row) => row.id);

  /*
   * Relational damage is checked first and is never acknowledgeable. It cannot be expressed as an
   * omission, so there is no honest label for a file written from such a state.
   */
  if (snapshot.relationalIssues.length > 0) {
    throw new RelationalIntegrityError(snapshot.relationalIssues);
  }

  if (invalidRowCount(snapshot.invalid) > 0 && options.acknowledgeOmissions !== true) {
    throw new IncompleteBackupError(snapshot.invalid);
  }

  const envelope = await buildEnvelope(snapshot.input, nowInstant());
  const blob = jsonBlob(serialiseEnvelope(envelope));
  const download = downloadBlob(blob, backupFilename(filenameStamp(at)));

  /*
   * Freshness is established only by a COMPLETE canonical backup.
   *
   * Phase 1.1 called `recordBackupSuccess()` unconditionally, so a file the application itself
   * described as incomplete set `lastBackupRevision = dataRevision` and suppressed the warning —
   * the user was told their data was backed up by a file that could not restore it.
   *
   * The revision written is the one captured inside the snapshot transaction, not the one current
   * now: if the data moved on while the file was being written, the correct state is stale.
   */
  let markedFresh = false;
  if (snapshot.complete) {
    await recordCanonicalBackup({
      capturedRevision: snapshot.capturedRevision,
      recordCount: envelope.counts.records,
    });
    markedFresh = true;
  }

  return { download, envelope, omitted, markedFresh };
}

/** Why a backup is stale, so the UI can say something more useful than "old". */
export type StaleReason = 'data-changed' | 'age';

export type BackupHealth =
  | { readonly state: 'never' }
  /** Nothing has ever been persisted, so there is nothing to back up yet. */
  | { readonly state: 'pristine' }
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
  reminderDays: number,
  today: string = todayIso(),
): BackupHealth {
  if (!meta) return { state: 'unknown' };

  /*
   * A genuinely pristine database — nothing has ever been persisted — is the only state that needs no
   * backup, and `dataRevision === 0` is exactly that: `ensureSeedData` writes the default taxonomy and
   * settings without touching the counter, and every user-data mutation bumps it.
   *
   * Phase 1.2 short-circuited on `currentRecordCount === 0`, the count of **live** records, which is
   * not a statement about whether anything is worth keeping. All of these have zero live records and
   * real user data: everything moved to the Trash (still carried in backups), custom categories or
   * groups, edited settings, or a database that held records and has since been emptied. In each case
   * the application reported 今天已备份 while holding data no backup contained.
   *
   * The record count is no longer an input at all, so no second "is anything valuable?" heuristic
   * exists to drift away from the revision model.
   */
  if (meta.dataRevision === 0 && meta.lastBackupAt === null) {
    return { state: 'pristine' };
  }

  if (meta.lastBackupAt === null) return { state: 'never' };

  const at = meta.lastBackupAt;
  let daysAgo: number;
  try {
    // The stored value is a UTC instant; `today` is a local business date. Comparing the instant's
    // first ten characters against it reads the UTC day and is wrong for part of every day — see
    // `businessDateOf`.
    daysAgo = Math.max(0, daysBetween(businessDateOf(at), today));
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
    case 'pristine':
      return '本机还没有任何数据，暂时无需备份。';
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
