import { ABSENT_DATE } from '@/domain/dates';
import type { DateValue } from '@/domain/dates';
import type { HonorRecord, ProgressEntry, WorkRecord } from '@/domain/types';
import type { WorkStatus } from '@/domain/status';

/**
 * Domain-record builders for tests. Synthetic content only — no real names or numbers.
 * Defaults are deliberately "boring" so each test states only what it is about.
 */

let sequence = 0;

export function resetFixtureSequence(): void {
  sequence = 0;
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}

export function plain(date: string): DateValue {
  return { kind: 'plain', date };
}

export function range(start: string, end: string): DateValue {
  return { kind: 'range', start, end };
}

export function freeText(text: string): DateValue {
  return { kind: 'text', text };
}

export interface WorkOverrides {
  id?: string;
  title?: string;
  occurredOn?: DateValue;
  status?: WorkStatus;
  statusLabel?: string;
  requirement?: string;
  reportDeadline?: DateValue;
  completionDeadline?: DateValue;
  completedOn?: DateValue;
  categoryId?: string | null;
  groupId?: string | null;
  longTerm?: boolean;
  counterpartUnit?: string;
  counterpartContact?: string;
  counterpartPhone?: string;
  remark?: string;
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function makeWork(overrides: WorkOverrides = {}): WorkRecord {
  return {
    id: overrides.id ?? nextId('work'),
    kind: 'work',
    title: overrides.title ?? '示范工作事项',
    occurredOn: overrides.occurredOn ?? plain('2026-09-01'),
    status: overrides.status ?? 'todo',
    statusLabel: overrides.statusLabel ?? '',
    requirement: overrides.requirement ?? '',
    reportDeadline: overrides.reportDeadline ?? ABSENT_DATE,
    completionDeadline: overrides.completionDeadline ?? ABSENT_DATE,
    completedOn: overrides.completedOn ?? ABSENT_DATE,
    categoryId: overrides.categoryId ?? null,
    groupId: overrides.groupId ?? null,
    longTerm: overrides.longTerm ?? false,
    counterpartUnit: overrides.counterpartUnit ?? '',
    counterpartContact: overrides.counterpartContact ?? '',
    counterpartPhone: overrides.counterpartPhone ?? '',
    remark: overrides.remark ?? '',
    legacyResidue: null,
    createdAt: overrides.createdAt ?? '2026-09-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-09-01T00:00:00.000Z',
    deletedAt: overrides.deletedAt ?? null,
  };
}

export interface HonorOverrides {
  id?: string;
  title?: string;
  awardedOn?: DateValue;
  honorType?: string;
  level?: string;
  issuingOrg?: string;
  documentNo?: string;
  personalRole?: string;
  evidenceLocation?: string;
  relatedWorkId?: string | null;
  remark?: string;
  deletedAt?: string | null;
}

export function makeHonor(overrides: HonorOverrides = {}): HonorRecord {
  return {
    id: overrides.id ?? nextId('honor'),
    kind: 'honor',
    title: overrides.title ?? '示范荣誉',
    awardedOn: overrides.awardedOn ?? plain('2026-06-20'),
    honorType: overrides.honorType ?? '表彰（先进集体/个人）',
    level: overrides.level ?? '市级',
    issuingOrg: overrides.issuingOrg ?? '示范颁发单位',
    documentNo: overrides.documentNo ?? '',
    personalRole: overrides.personalRole ?? '',
    evidenceLocation: overrides.evidenceLocation ?? '',
    relatedWorkId: overrides.relatedWorkId ?? null,
    remark: overrides.remark ?? '',
    legacyResidue: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    deletedAt: overrides.deletedAt ?? null,
  };
}

export function makeProgress(
  recordId: string,
  note: string,
  occurredOn?: DateValue,
): ProgressEntry {
  return {
    id: nextId('progress'),
    recordId,
    occurredOn: occurredOn ?? ABSENT_DATE,
    note,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}
