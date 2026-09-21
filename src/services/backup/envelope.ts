import { z } from 'zod';
import { SCHEMA_VERSION } from '@/db/schema';
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

/** Envelope format version. Bump when the envelope *shape* changes, not when the schema does. */
export const BACKUP_FORMAT_VERSION = 1;

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

export const backupEnvelopeSchema = z.object({
  application: z.literal(BACKUP_APP_ID),
  backupFormatVersion: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  exportedAt: z.string().min(1),
  counts: backupCountsSchema,
  /** SHA-256 of the canonical payload, hex. Null when Web Crypto was unavailable. */
  payloadChecksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  payload: backupPayloadSchema,
});

export type BackupCounts = z.infer<typeof backupCountsSchema>;
export type BackupPayload = z.infer<typeof backupPayloadSchema>;
export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;

export interface BackupInput {
  readonly records: readonly AnyRecord[];
  readonly progressEntries: readonly ProgressEntry[];
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly settings: AppSettings;
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
  return {
    application: BACKUP_APP_ID,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    counts: countEntities(input),
    payloadChecksum: await sha256Hex(canonicalJson(payload)),
    payload,
  };
}

export function serialiseEnvelope(envelope: BackupEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export type ChecksumVerdict = 'match' | 'mismatch' | 'absent' | 'unverifiable';

/**
 * Re-derive the checksum and compare. `absent` means the file carried none (older or degraded
 * export); `unverifiable` means this runtime cannot hash. Neither is treated as corruption, but
 * both are reported to the user rather than glossed over.
 */
export async function verifyChecksum(envelope: BackupEnvelope): Promise<ChecksumVerdict> {
  if (envelope.payloadChecksum === null) return 'absent';
  const actual = await sha256Hex(canonicalJson(envelope.payload));
  if (actual === null) return 'unverifiable';
  return actual === envelope.payloadChecksum ? 'match' : 'mismatch';
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
