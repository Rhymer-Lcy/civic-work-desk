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
 * The rule now: compatibility is declared, never inferred from structural similarity.
 */

/** The envelope version this build writes. */
export const BACKUP_FORMAT_VERSION = 2;

/**
 * Envelope versions this build can read.
 *
 * - **1** — Phase 1. No `omittedInvalidRowIds`, no `dataRevision`. Upgraded by `migrateEnvelope`.
 * - **2** — Phase 1.1. Records which rows a backup knowingly excluded, and the data revision it
 *   captured.
 */
export const SUPPORTED_BACKUP_FORMAT_VERSIONS: readonly number[] = Object.freeze([1, 2]);

/**
 * Database schema versions this build can restore.
 *
 * A backup from a *newer* schema may contain fields or stores this build does not understand, so
 * it is refused. An older schema is accepted and passes through the Dexie upgrade path on write.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION;

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
 * cannot be named is a migration nobody can review.
 */
export function migrateEnvelope(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  if (current['backupFormatVersion'] === 1) current = migrateV1ToV2(current);
  return current;
}

/**
 * v1 -> v2.
 *
 * v1 had no way to say "this backup knowingly excluded rows", because v1 excluded them silently —
 * the defect this field exists to prevent. A v1 file is therefore treated as claiming nothing was
 * omitted, which is what it claimed at the time.
 */
function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    backupFormatVersion: 2,
    omittedInvalidRowIds: [],
    dataRevision: null,
  };
}
