import { z } from '@/domain/zod';
import { SCHEMA_VERSION } from '@/db/schema';
import { BACKUP_FORMAT_VERSION } from './compatibility';
import {
  anyRecordSchema,
  businessCategorySchema,
  progressEntrySchema,
  workGroupSchema,
  appSettingsSchema,
} from '@/domain/validation';
import type {
  AnyRecord,
  AppSettings,
  BusinessCategory,
  ProgressEntry,
  WorkGroup,
} from '@/domain/types';

/**
 * The canonical backup format.
 *
 * JSON is the *only* backup. XLSX and DOCX are reports: they are lossy by design (no ids, no
 * progress entries, no soft-delete state, no settings) and cannot restore an archive. The legacy
 * prototype blurred this — `exportExcel()` wrote `gov_last_backup`, so exporting a spreadsheet
 * silenced the backup reminder for a week without a backup existing.
 *
 * The envelope is self-describing so a file found in three years can be understood without this
 * codebase: it names the application, its own format version, the database schema version it came
 * from, when it was written, how many of each entity it contains, and a checksum of the payload.
 */

export const BACKUP_APP_ID = 'civic-work-desk';

export { BACKUP_FORMAT_VERSION } from './compatibility';

export const backupCountsSchema = z.object({
  records: z.number().int().min(0),
  workRecords: z.number().int().min(0),
  honorRecords: z.number().int().min(0),
  progressEntries: z.number().int().min(0),
  categories: z.number().int().min(0),
  groups: z.number().int().min(0),
});

export const backupPayloadSchema = z.object({
  records: z.array(anyRecordSchema),
  progressEntries: z.array(progressEntrySchema),
  categories: z.array(businessCategorySchema),
  groups: z.array(workGroupSchema),
  settings: appSettingsSchema,
});

/**
 * The file's integrity digest, and what it covers.
 *
 * Phase 1.1 hashed `payload` alone, while `omittedInvalidRowIds` — the field that decides whether a
 * file may be used for an exact restore — sat outside the digest. A one-character edit to that list
 * turned an incomplete archive into a complete-looking one with the checksum still matching.
 *
 * v3 hashes the whole envelope except this field. v1/v2 files keep their narrower payload scope,
 * recorded honestly rather than recomputed (see `migrateEnvelope`).
 *
 * This is **corruption detection, not authentication**. Anyone who edits the file can recompute the
 * digest; it catches accidental truncation, a stray editor save, a half-written download. Calling it
 * a signature would be a lie — there is no key.
 */
export const checksumSchema = z.object({
  algorithm: z.literal('sha-256'),
  scope: z.union([z.literal('envelope'), z.literal('payload')]),
  value: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

/**
 * Envelope shape (v3).
 *
 * Version *ranges* are deliberately NOT enforced here — `checkCompatibility` owns that policy and
 * runs first, so an unsupported version produces a precise message instead of a shape error. Zod
 * only asserts the fields are present and well-typed, and this schema is applied **after**
 * `migrateEnvelope` has brought a v1/v2 file up to the v3 shape.
 *
 * Phase 1 wrote `min(1)` on both version fields, which accepted any integer: a file from a future
 * build was read merely because its current shape happened to validate.
 */
export const backupEnvelopeSchema = z.object({
  application: z.literal(BACKUP_APP_ID),
  backupFormatVersion: z.number().int(),
  schemaVersion: z.number().int(),
  exportedAt: z.string().min(1),
  counts: backupCountsSchema,
  /**
   * How much of the original database this file can be trusted to contain.
   *
   * Explicit since v3. Derived for a migrated v2 file, and `unknown-legacy` for a v1 file, which
   * could omit rows without recording anything.
   */
  completeness: z.union([
    z.literal('complete'),
    z.literal('incomplete'),
    z.literal('unknown-legacy'),
  ]),
  /**
   * Ids of stored rows this backup knowingly excluded because they failed validation.
   *
   * Empty alongside `completeness: 'complete'` is the normal case. A non-empty list is the file
   * stating plainly that it is NOT a complete archive — Phase 1 dropped such rows silently.
   */
  omittedInvalidRowIds: z.array(z.string()).default([]),
  /** The `dataRevision` this backup captured, inside the snapshot transaction. */
  dataRevision: z.number().int().nullable().default(null),
  checksum: checksumSchema,
  payload: backupPayloadSchema,
});

export type BackupCounts = z.infer<typeof backupCountsSchema>;
export type BackupPayload = z.infer<typeof backupPayloadSchema>;
export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;
export type EnvelopeChecksum = z.infer<typeof checksumSchema>;

export interface BackupInput {
  readonly records: readonly AnyRecord[];
  /** Ids of rows excluded because they failed validation. Recorded in the envelope. */
  readonly omittedInvalidRowIds?: readonly string[];
  readonly dataRevision?: number | null;
  readonly progressEntries: readonly ProgressEntry[];
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly settings: AppSettings;
}

/** True when this file may be used as the source of an exact canonical restore. */
export function envelopeIsVerifiedComplete(envelope: BackupEnvelope): boolean {
  return envelope.completeness === 'complete' && envelope.omittedInvalidRowIds.length === 0;
}

export function countEntities(input: BackupInput): BackupCounts {
  let workRecords = 0;
  let honorRecords = 0;
  for (const record of input.records) {
    if (record.kind === 'work') workRecords += 1;
    else honorRecords += 1;
  }
  return {
    records: input.records.length,
    workRecords,
    honorRecords,
    progressEntries: input.progressEntries.length,
    categories: input.categories.length,
    groups: input.groups.length,
  };
}

/**
 * Deterministic JSON with sorted object keys.
 *
 * The checksum must be reproducible from the file alone, so key order cannot depend on the
 * order properties happened to be assigned in. Arrays keep their order, which is meaningful.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * SHA-256 of a string, hex. Returns null when Web Crypto is unavailable.
 *
 * `crypto.subtle` requires a secure context. Both supported runtime modes qualify (HTTPS and
 * localhost/loopback), so in practice this returns a hash; the null path exists so an unusual
 * host degrades to an unchecksummed but still valid backup instead of failing to back up at all.
 */
export async function sha256Hex(input: string): Promise<string | null> {
  // `crypto.subtle` is typed as always present but is absent in insecure contexts, so the guard
  // reads the property defensively rather than trusting the DOM lib.
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) return null;
  try {
    const bytes = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function buildEnvelope(
  input: BackupInput,
  exportedAt: string,
): Promise<BackupEnvelope> {
  // Readonly domain collections are copied into the mutable shapes the Zod-inferred payload type
  // uses; the envelope is a serialisation boundary, so a defensive copy is correct here anyway.
  const payload: BackupPayload = {
    records: [...input.records] as BackupPayload['records'],
    progressEntries: [...input.progressEntries] as BackupPayload['progressEntries'],
    categories: [...input.categories],
    groups: [...input.groups],
    settings: {
      appTitle: input.settings.appTitle,
      appSubtitle: input.settings.appSubtitle,
      backupReminderDays: input.settings.backupReminderDays,
      options: {
        honorType: [...input.settings.options.honorType],
        honorLevel: [...input.settings.options.honorLevel],
        personalRole: [...input.settings.options.personalRole],
      },
    },
  };
  const omittedInvalidRowIds = [...(input.omittedInvalidRowIds ?? [])];
  /*
   * A file declares itself complete only when nothing was omitted. The caller cannot override this:
   * completeness is a property of the snapshot, not a claim the export decides to make.
   */
  const withoutChecksum: Omit<BackupEnvelope, 'checksum'> = {
    application: BACKUP_APP_ID,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    counts: countEntities(input),
    completeness: omittedInvalidRowIds.length === 0 ? 'complete' : 'incomplete',
    omittedInvalidRowIds,
    dataRevision: input.dataRevision ?? null,
    payload,
  };
  return {
    ...withoutChecksum,
    checksum: {
      algorithm: 'sha-256',
      scope: 'envelope',
      value: await sha256Hex(canonicalJson(withoutChecksum)),
    },
  };
}

/**
 * The exact material a v3 checksum covers: the whole envelope minus the checksum field.
 *
 * Stated as one function so the producer and the verifier cannot drift apart, and so the answer to
 * "what is protected?" is readable rather than inferred.
 *
 * **Everything else participates**, deliberately:
 *
 * | field | participates | why |
 * | --- | --- | --- |
 * | `payload` | yes | the data itself |
 * | `completeness`, `omittedInvalidRowIds` | yes | they decide whether an exact restore is allowed |
 * | `application`, `backupFormatVersion`, `schemaVersion` | yes | format identity; editing them changes how the file is read |
 * | `counts` | yes | a mismatch is already a blocker, and a tampered count should not verify |
 * | `dataRevision` | yes | it becomes this installation's backup bookkeeping after a restore |
 * | `exportedAt` | yes | it is displayed as provenance, so silent edits should be detectable |
 * | `checksum` | no | a digest cannot cover itself |
 *
 * The rule is therefore simply "everything except the digest", which needs no per-field judgement
 * when a field is added later.
 */
export function checksumMaterial(envelope: BackupEnvelope): string {
  const rest: Record<string, unknown> = { ...envelope };
  delete rest['checksum'];
  return canonicalJson(rest);
}

export function serialiseEnvelope(envelope: BackupEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export type ChecksumVerdict = 'match' | 'mismatch' | 'absent' | 'unverifiable';

/**
 * Re-derive the checksum and compare, over the material the file says it covers.
 *
 * `absent` means the file carried none (a degraded export from a host without Web Crypto);
 * `unverifiable` means *this* runtime cannot hash. Neither is treated as corruption, but both are
 * reported rather than glossed over.
 *
 * The scope is read from the file: a v1/v2 archive's digest covers only its payload, and verifying
 * it against the wider v3 material would report every older file as corrupt.
 */
export async function verifyChecksum(envelope: BackupEnvelope): Promise<ChecksumVerdict> {
  if (envelope.checksum.value === null) return 'absent';
  const material =
    envelope.checksum.scope === 'envelope'
      ? checksumMaterial(envelope)
      : canonicalJson(envelope.payload);
  const actual = await sha256Hex(material);
  if (actual === null) return 'unverifiable';
  return actual === envelope.checksum.value ? 'match' : 'mismatch';
}

/** Counts declared in the envelope must match the payload it carries. */
export function countsAreConsistent(envelope: BackupEnvelope): boolean {
  const actual = countEntities({
    records: envelope.payload.records,
    progressEntries: envelope.payload.progressEntries,
    categories: envelope.payload.categories,
    groups: envelope.payload.groups,
    settings: envelope.payload.settings,
  });
  return canonicalJson(actual) === canonicalJson(envelope.counts);
}

/**
 * Deterministic, sortable backup filename.
 * `civic-work-desk-backup-20260921-143052.json`
 */
export function backupFilename(stamp: string): string {
  return `${BACKUP_APP_ID}-backup-${stamp}.json`;
}
