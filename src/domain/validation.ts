import { z } from 'zod';
import { isIsoDate } from './dates';
import { WORK_STATUSES } from './status';

/**
 * Runtime schemas for domain entities.
 *
 * These guard the two boundaries where untrusted data enters: a user-supplied backup file and
 * the IndexedDB read path (a store can be edited by devtools, or written by an older build).
 * The legacy prototype had neither guard — `loadData()` did `works = JSON.parse(raw)` and then
 * `works.forEach(...)`, so a non-array value threw inside a render pass and left a blank page.
 */

export const isoDateSchema = z.string().refine(isIsoDate, {
  message: 'expected a real calendar date in YYYY-MM-DD form',
});

export const isoInstantSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'expected an ISO 8601 instant',
});

export const dateValueSchema = z.union([
  z.object({ kind: z.literal('absent') }),
  z.object({ kind: z.literal('plain'), date: isoDateSchema }),
  z
    .object({ kind: z.literal('range'), start: isoDateSchema, end: isoDateSchema })
    .refine((v) => v.start <= v.end, { message: 'range start must not be after end' }),
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1) }),
]);

export const workStatusSchema = z.enum(WORK_STATUSES);

/** Free-text fields are trimmed of trailing whitespace but otherwise preserved verbatim. */
const textField = z.string();

const legacyResidueSchema = z.record(z.string(), z.string()).nullable();

const entityBaseShape = {
  id: z.string().min(1),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
  deletedAt: isoInstantSchema.nullable(),
};

export const workRecordSchema = z.object({
  ...entityBaseShape,
  kind: z.literal('work'),
  title: textField,
  occurredOn: dateValueSchema,
  status: workStatusSchema,
  statusLabel: textField,
  requirement: textField,
  reportDeadline: dateValueSchema,
  completionDeadline: dateValueSchema,
  completedOn: dateValueSchema,
  categoryId: z.string().min(1).nullable(),
  groupId: z.string().min(1).nullable(),
  longTerm: z.boolean(),
  counterpartUnit: textField,
  counterpartContact: textField,
  counterpartPhone: textField,
  remark: textField,
  legacyResidue: legacyResidueSchema,
});

export const honorRecordSchema = z.object({
  ...entityBaseShape,
  kind: z.literal('honor'),
  title: textField,
  awardedOn: dateValueSchema,
  honorType: textField,
  level: textField,
  issuingOrg: textField,
  documentNo: textField,
  personalRole: textField,
  evidenceLocation: textField,
  relatedWorkId: z.string().min(1).nullable(),
  remark: textField,
  legacyResidue: legacyResidueSchema,
});

export const anyRecordSchema = z.discriminatedUnion('kind', [workRecordSchema, honorRecordSchema]);

export const progressEntrySchema = z.object({
  id: z.string().min(1),
  recordId: z.string().min(1),
  occurredOn: dateValueSchema,
  note: textField,
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});

export const businessCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int(),
  builtIn: z.boolean(),
  archived: z.boolean(),
});

export const workGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int(),
  builtIn: z.boolean(),
  archived: z.boolean(),
});

export const optionSetsSchema = z.object({
  honorType: z.array(z.string().trim().min(1)),
  honorLevel: z.array(z.string().trim().min(1)),
  personalRole: z.array(z.string().trim().min(1)),
});

export const appSettingsSchema = z.object({
  appTitle: z.string().trim().min(1).max(80),
  appSubtitle: z.string().max(160),
  options: optionSetsSchema,
  backupReminderDays: z.number().int().min(1).max(365),
});

export type ValidatedWorkRecord = z.infer<typeof workRecordSchema>;
export type ValidatedHonorRecord = z.infer<typeof honorRecordSchema>;
export type ValidatedAnyRecord = z.infer<typeof anyRecordSchema>;

/** Collapse a Zod error into short, field-anchored messages for the import preview. */
export function describeIssues(error: z.ZodError, limit = 4): string[] {
  return error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
