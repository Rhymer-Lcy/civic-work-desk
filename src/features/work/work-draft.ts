import { ABSENT_DATE } from '@/domain/dates';
import type { DateValue } from '@/domain/dates';
import type { WorkStatus } from '@/domain/status';
import type { WorkRecord } from '@/domain/types';

/**
 * The editable shape of a work record.
 *
 * Kept out of the dialog component so that file exports only components — React Fast Refresh
 * cannot preserve state across edits of a module that also exports plain functions.
 */
export interface WorkDraft {
  title: string;
  occurredOn: DateValue;
  status: WorkStatus;
  requirement: string;
  reportDeadline: DateValue;
  completionDeadline: DateValue;
  completedOn: DateValue;
  categoryId: string | null;
  groupId: string | null;
  longTerm: boolean;
  counterpartUnit: string;
  counterpartContact: string;
  counterpartPhone: string;
  remark: string;
}

export function emptyWorkDraft(): WorkDraft {
  return {
    title: '',
    occurredOn: ABSENT_DATE,
    status: 'todo',
    requirement: '',
    reportDeadline: ABSENT_DATE,
    completionDeadline: ABSENT_DATE,
    completedOn: ABSENT_DATE,
    categoryId: null,
    groupId: null,
    longTerm: false,
    counterpartUnit: '',
    counterpartContact: '',
    counterpartPhone: '',
    remark: '',
  };
}

export function draftFromRecord(record: WorkRecord): WorkDraft {
  return {
    title: record.title,
    occurredOn: record.occurredOn,
    status: record.status,
    requirement: record.requirement,
    reportDeadline: record.reportDeadline,
    completionDeadline: record.completionDeadline,
    completedOn: record.completedOn,
    categoryId: record.categoryId,
    groupId: record.groupId,
    longTerm: record.longTerm,
    counterpartUnit: record.counterpartUnit,
    counterpartContact: record.counterpartContact,
    counterpartPhone: record.counterpartPhone,
    remark: record.remark,
  };
}
