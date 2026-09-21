import type { DateValue } from './dates';
import type { WorkStatus } from './status';

/**
 * Domain entities.
 *
 * Work records and honour records were one shape in the legacy prototype, discriminated by a
 * `category` string that was empty on all 178 embedded work rows and set only on honours.
 * Every honour field (`hType`, `hLevel`, `hNo`, `hRole`, `hEvidence`, `hRelated`) therefore sat
 * unused on every work row, and every deadline field sat unused on every honour row.
 *
 * Here `kind` is a real discriminant, so each shape carries only fields that apply to it.
 */

export type RecordKind = 'work' | 'honor';

/** ISO 8601 instant with offset, e.g. `2026-09-21T14:30:52.000Z`. Audit metadata, not a business date. */
export type IsoInstant = string;

interface EntityBase {
  readonly id: string;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  /** Soft delete. Non-null means the record is in the trash; see docs/data-model.md. */
  readonly deletedAt: IsoInstant | null;
}

export interface WorkRecord extends EntityBase {
  readonly kind: 'work';
  readonly title: string;
  /** The date the item arose / was logged. Legacy `date`. */
  readonly occurredOn: DateValue;
  /** Canonical state. Drives every count, filter and urgency calculation. */
  readonly status: WorkStatus;
  /**
   * The wording the record arrived with (legacy `done`), kept verbatim so a migrated archive
   * still reads the way its author wrote it. Empty when the status was set in this app.
   */
  readonly statusLabel: string;
  /** What has to be produced. Legacy `requirement`. */
  readonly requirement: string;
  /** External reporting deadline. Legacy `deadline` + `deadlineType`. */
  readonly reportDeadline: DateValue;
  /** Internal completion deadline. Legacy `due` + `dueType`. */
  readonly completionDeadline: DateValue;
  /** When it was actually finished. Legacy `doneTime`, which was frequently free text. */
  readonly completedOn: DateValue;
  /** Stable id into `categories`. Renaming a category cannot orphan a record. */
  readonly categoryId: string | null;
  /** Stable id into `groups` (fixed / long-term / supervised). */
  readonly groupId: string | null;
  /**
   * Long-running item tracked separately. Orthogonal to `status`: a long-term item can be
   * completed, and completion wins in every display.
   */
  readonly longTerm: boolean;
  readonly counterpartUnit: string;
  readonly counterpartContact: string;
  /** Always a string. Phone numbers are identifiers, never numbers. */
  readonly counterpartPhone: string;
  readonly remark: string;
  /** Values that could not be mapped losslessly on import, kept for human adjudication. */
  readonly legacyResidue: Readonly<Record<string, string>> | null;
}

export interface HonorRecord extends EntityBase {
  readonly kind: 'honor';
  /** The honour's name. Legacy `title` (or `name` in the oldest backups). */
  readonly title: string;
  /** Date awarded. Legacy `date`. */
  readonly awardedOn: DateValue;
  /** Legacy `hType`. */
  readonly honorType: string;
  /** Legacy `hLevel`. */
  readonly level: string;
  /** Legacy `unit` — for an honour this is the issuing body, not a counterpart. */
  readonly issuingOrg: string;
  /** Legacy `hNo`. */
  readonly documentNo: string;
  /** Legacy `hRole`. */
  readonly personalRole: string;
  /** Legacy `hEvidence`. */
  readonly evidenceLocation: string;
  /** Legacy `hRelated`: id of a work record, or null. */
  readonly relatedWorkId: string | null;
  readonly remark: string;
  readonly legacyResidue: Readonly<Record<string, string>> | null;
}

export type AnyRecord = WorkRecord | HonorRecord;

export function isWorkRecord(record: AnyRecord): record is WorkRecord {
  return record.kind === 'work';
}

export function isHonorRecord(record: AnyRecord): record is HonorRecord {
  return record.kind === 'honor';
}

/** The date a record is filed under, whichever kind it is. */
export function primaryDate(record: AnyRecord): DateValue {
  return record.kind === 'work' ? record.occurredOn : record.awardedOn;
}

/**
 * A progress note. Its own store with its own stable id, unlike the legacy prototype where
 * progress lived in an array on the record and was addressed by array index — so deleting
 * entry 0 silently renumbered every later entry and any pending edit hit the wrong row.
 */
export interface ProgressEntry {
  readonly id: string;
  readonly recordId: string;
  /** The business day the progress happened on. */
  readonly occurredOn: DateValue;
  readonly note: string;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
}

/** A business category. Records reference `id`, so `name` is free to change. */
export interface BusinessCategory {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  /** Shipped with the product. Renamable and archivable, but not deletable. */
  readonly builtIn: boolean;
  readonly archived: boolean;
}

/** A sidebar grouping: fixed work, long-term work, supervised work. */
export interface WorkGroup {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly builtIn: boolean;
  readonly archived: boolean;
}

/** User-editable enumerations offered in the honour form. */
export interface OptionSets {
  readonly honorType: readonly string[];
  readonly honorLevel: readonly string[];
  readonly personalRole: readonly string[];
}

export interface AppSettings {
  /** Chinese product title. Configurable; default preserves the legacy wording. */
  readonly appTitle: string;
  readonly appSubtitle: string;
  readonly options: OptionSets;
  /** Days without a canonical JSON backup before Settings shows a warning. */
  readonly backupReminderDays: number;
}

/**
 * Non-user data: schema bookkeeping and backup health.
 *
 * Deliberately **not** carried in or restored from a backup — it describes this installation,
 * not the archive. See `src/services/import/apply.ts` for that boundary.
 */
export interface AppMeta {
  readonly schemaVersion: number;
  /**
   * Monotonic counter bumped by every successfully persisted user-data mutation.
   *
   * Phase 1 judged backup freshness by age and record count alone, so editing an existing record
   * left the backup looking current: the count had not changed. Comparing revisions detects any
   * mutation, including an edit, a soft delete and a settings change.
   */
  readonly dataRevision: number;
  readonly lastBackupAt: IsoInstant | null;
  /** The `dataRevision` the last canonical JSON backup captured. Null when never backed up. */
  readonly lastBackupRevision: number | null;
  readonly lastBackupRecordCount: number | null;
  readonly createdAt: IsoInstant;
}
