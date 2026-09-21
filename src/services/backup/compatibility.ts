import { SCHEMA_VERSION } from '@/db/schema';

/**
 * Backup compatibility policy.
 *
 * Phase 1 validated `backupFormatVersion: z.number().int().min(1)` and
 * `schemaVersion: z.number().int().min(1)`, which accepted **any** integer. A file written by a
 * future version of the application was therefore accepted purely because its current shape
 * happened to validate — the importer would silently discard fields it did not know about and
 * present the result as a faithful restore.
 *
 * The rule: compatibility is declared, never inferred from structural similarity. The same rule now
 * applies to *completeness*, which is a separate question from readability — see `BackupCompleteness`.
 */

/** The envelope version this build writes. */
export const BACKUP_FORMAT_VERSION = 3;

/**
 * Envelope versions this build can read.
 *
 * - **1** — Phase 1. No completeness metadata, no `dataRevision`. Phase 1 could also omit invalid
 *   rows *silently*, so a v1 file cannot prove that nothing was omitted: it is classified
 *   `unknown-legacy`, never `complete`.
 * - **2** — Phase 1.1. Added `omittedInvalidRowIds` and `dataRevision`. Completeness is derivable,
 *   but the checksum covered only `payload`, so the completeness metadata itself was unprotected.
 * - **3** — Phase 1.2. Completeness is explicit, and the checksum covers the whole envelope
 *   including that metadata.
 */
export const SUPPORTED_BACKUP_FORMAT_VERSIONS: readonly number[] = Object.freeze([1, 2, 3]);

/**
 * Database schema versions this build can restore.
 *
 * A backup from a *newer* schema may contain fields or stores this build does not understand, so
 * it is refused. An older schema is accepted and passes through the Dexie upgrade path on write.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * How much of the original database a file can be trusted to contain.
 *
 * - `complete` — the producing build verified every user-data store validated, and says so in a
 *   field the checksum protects. Only this state permits an exact canonical restore.
 * - `incomplete` — the file itself declares rows it could not carry. It may be merged, but it can
 *   never reproduce the original database, so exact restore is refused rather than mislabelled.
 * - `unknown-legacy` — a v1 archive. The format had no completeness field **and** the build that
 *   wrote it could drop invalid rows without recording anything, so absence of the field is not
 *   evidence of completeness. Restorable, with wording that says completeness is unknown.
 */
export type BackupCompleteness = 'complete' | 'incomplete' | 'unknown-legacy';

/** What material a file's checksum actually covers. */
export type ChecksumScope =
  /** v3: the entire envelope except the checksum field itself. */
  | 'envelope'
  /** v1/v2: the payload only. Completeness metadata was not protected. */
  | 'payload';

export interface CompatibilityVerdict {
  readonly compatible: boolean;
  /** User-facing, precise, and never a generic "校验失败". */
  readonly message?: string;
  readonly detail?: string;
}

/** The header fields needed to judge compatibility, read before the payload is validated. */
export interface EnvelopeHeader {
  readonly backupFormatVersion: unknown;
  readonly schemaVersion: unknown;
}

/**
 * Decide whether this build may read the file.
 *
 * Deliberately checked **before** full payload validation: an unknown future version will usually
 * also fail the current Zod schema, and reporting that as "内容未通过校验" would send the user
 * hunting for corruption that does not exist.
 */
export function checkCompatibility(header: EnvelopeHeader): CompatibilityVerdict {
  const format = header.backupFormatVersion;
  if (typeof format !== 'number' || !Number.isInteger(format)) {
    return {
      compatible: false,
      message: '备份文件没有声明有效的格式版本，无法确认兼容性。',
    };
  }
  if (!SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(format)) {
    const known = SUPPORTED_BACKUP_FORMAT_VERSIONS.join('、');
    return {
      compatible: false,
      message:
        format > BACKUP_FORMAT_VERSION
          ? `该备份来自更新版本的 CivicWorkDesk（备份格式 v${String(format)}），当前版本无法读取。`
          : `不支持的备份格式版本 v${String(format)}。`,
      detail: `当前版本支持的备份格式：v${known}；本机写出的版本：v${String(BACKUP_FORMAT_VERSION)}。请升级应用后再导入。`,
    };
  }

  const schema = header.schemaVersion;
  if (typeof schema !== 'number' || !Number.isInteger(schema)) {
    return {
      compatible: false,
      message: '备份文件没有声明有效的数据库架构版本，无法确认兼容性。',
    };
  }
  if (schema > MAX_SUPPORTED_SCHEMA_VERSION) {
    return {
      compatible: false,
      message: `该备份来自更新的数据库架构（v${String(schema)}），当前版本无法安全还原。`,
      detail: `当前支持的架构版本上限为 v${String(MAX_SUPPORTED_SCHEMA_VERSION)}。请升级应用后再导入。`,
    };
  }
  if (schema < MIN_SUPPORTED_SCHEMA_VERSION) {
    return {
      compatible: false,
      message: `不支持的数据库架构版本 v${String(schema)}。`,
    };
  }

  return { compatible: true };
}

/**
 * Bring a supported older envelope up to the current shape.
 *
 * Explicit per-version steps, not a defaulting `??` scattered through the reader: a migration that
 * cannot be named is a migration nobody can review. Each step is deterministic — the same input
 * always produces the same output — which is what makes the migrated file's checksum verdict
 * meaningful.
 */
export function migrateEnvelope(raw: Record<string, unknown>): Record<string, unknown> {
  const original = raw['backupFormatVersion'];
  let current = raw;
  if (original === 1) current = migrateV1ToV2(current);
  if (current['backupFormatVersion'] === 2) {
    current = migrateV2ToV3(current, original === 1 ? 1 : 2);
  }
  return current;
}

/**
 * v1 -> v2, structurally.
 *
 * v1 had no `omittedInvalidRowIds` field. It is added **empty** because that is the v2 shape, not
 * because the file is known to be complete — `migrateV2ToV3` receives the original version and
 * classifies a v1 file as `unknown-legacy` for exactly that reason. Phase 1.1's migration stopped
 * here and let the empty list be read as proof of completeness; it was not.
 */
function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    backupFormatVersion: 2,
    omittedInvalidRowIds: [],
    dataRevision: null,
  };
}

/**
 * v2 -> v3.
 *
 * Two shape changes:
 *
 *  - completeness becomes explicit, derived from the omission list for a genuine v2 file and set to
 *    `unknown-legacy` when the file was originally v1;
 *  - `payloadChecksum` becomes a `checksum` object carrying its **scope**. A v1/v2 digest covered
 *    only `payload`, so it is recorded as `scope: 'payload'` and verified that way. It is not
 *    recomputed over the wider v3 material: a digest this build calculated itself would verify
 *    nothing about the file as received.
 */
function migrateV2ToV3(
  raw: Record<string, unknown>,
  originalVersion: 1 | 2,
): Record<string, unknown> {
  const omitted = raw['omittedInvalidRowIds'];
  const omittedCount = Array.isArray(omitted) ? omitted.length : 0;
  const completeness: BackupCompleteness =
    originalVersion === 1 ? 'unknown-legacy' : omittedCount > 0 ? 'incomplete' : 'complete';

  const legacyChecksum = raw['payloadChecksum'];
  const next: Record<string, unknown> = {
    ...raw,
    backupFormatVersion: 3,
    completeness,
    checksum: {
      algorithm: 'sha-256',
      scope: 'payload' satisfies ChecksumScope,
      value: typeof legacyChecksum === 'string' ? legacyChecksum : null,
    },
  };
  delete next['payloadChecksum'];
  return next;
}

/** Human wording for a completeness class, used by the import preview and the docs. */
export function describeCompleteness(completeness: BackupCompleteness): string {
  switch (completeness) {
    case 'complete':
      return '完整：写出这份备份时，本机所有用户数据均通过结构校验。';
    case 'incomplete':
      return '不完整：该文件自述省略了未通过校验的数据行，因此无法精确重建原数据库。';
    case 'unknown-legacy':
      return '完整性未知：这是旧版（v1）备份，当时的格式没有完整性声明，写出它的版本也可能已静默丢弃损坏行。';
  }
}
