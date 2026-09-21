import { anchorDay, formatDateValue, monthOf, overlapsWindow, todayIso, yearOf } from './dates';
import type { IsoDate } from './dates';
import {
  URGENCY_WEIGHT,
  evaluateDeadline,
  isStaleBacklog,
  needsFollowUp,
  overdueDays,
} from './deadlines';
import type { DeadlineVerdict } from './deadlines';
import type { WorkStatus } from './status';
import { isWorkStatus } from './status';
import { isWorkRecord, primaryDate } from './types';
import type { AnyRecord, WorkRecord } from './types';

/**
 * One query engine for every list in the product.
 *
 * The legacy prototype had two independent filter implementations — `getFilteredList()` for
 * the main list and `renderArchiveView()` for the ledger — and they disagreed:
 *   - the main list required `/^\d{4}$/` for a year option, the ledger accepted any
 *     `date.slice(0,4)`, so a record dated `1月` produced a bogus "1月年" option in one view;
 *   - the main list filtered months with `date.slice(5,7)`, the ledger with `fmtMonth(date)`;
 *   - the main list searched `hLevel` and `hEvidence`, the ledger searched a different subset.
 * A record could therefore be visible in the ledger and absent from the list for the same filter.
 *
 * Everything here is pure and synchronous. Views pass a `RecordQuery`; nothing else filters.
 */

export type KindFilter = 'all' | 'work' | 'honor';

/** A saturating view over canonical status, matching the tab strip. */
export type StatusBucket =
  | 'all'
  | 'open'
  | 'todo'
  | 'in-progress'
  | 'completed'
  | 'cancelled'
  | 'deferred'
  | 'long-term'
  | 'overdue'
  | 'stale-backlog';

export type SortKey =
  'date-desc' | 'date-asc' | 'urgency' | 'title-asc' | 'updated-desc' | 'overdue-desc';

export interface RecordQuery {
  readonly kind: KindFilter;
  readonly statusBucket: StatusBucket;
  readonly search: string;
  readonly categoryId: string | null;
  readonly groupId: string | null;
  readonly unit: string | null;
  readonly honorLevel: string | null;
  /** `YYYY`, or null for all years. */
  readonly year: string | null;
  /** `MM`, or null for all months. Composes with `year`; independent of it. */
  readonly month: string | null;
  /** Inclusive start of an explicit date window. */
  readonly dateFrom: IsoDate | null;
  /** Inclusive end of an explicit date window. */
  readonly dateTo: IsoDate | null;
  /** Exact-day selection coming from the calendar. */
  readonly onDay: IsoDate | null;
  readonly sort: SortKey;
  /** When false (default) soft-deleted records are hidden. */
  readonly includeDeleted: boolean;
}

export const EMPTY_QUERY: RecordQuery = Object.freeze({
  kind: 'all',
  statusBucket: 'all',
  search: '',
  categoryId: null,
  groupId: null,
  unit: null,
  honorLevel: null,
  year: null,
  month: null,
  dateFrom: null,
  dateTo: null,
  onDay: null,
  sort: 'date-desc',
  includeDeleted: false,
});

/** Which filters are active, for the "active filter chips" row and the clear-all affordance. */
export interface ActiveFilter {
  readonly key: keyof RecordQuery;
  readonly label: string;
  readonly value: string;
}

/**
 * Normalise text for comparison without touching what is stored.
 * Full-width spaces appear throughout the legacy data (`郑  琦`), so they collapse too.
 */
export function normaliseForSearch(input: string): string {
  // JavaScript's `\s` already matches the full-width space U+3000, which appears throughout the
  // legacy data (`郑  琦`), so no extra character class is needed.
  return input.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Every field a search term is tested against. Single definition, used by all views. */
export function searchableText(record: AnyRecord): string {
  const common = [record.title, record.remark, formatDateValue(primaryDate(record), '')];
  const specific = isWorkRecord(record)
    ? [
        record.requirement,
        record.statusLabel,
        record.counterpartUnit,
        record.counterpartContact,
        record.counterpartPhone,
        formatDateValue(record.reportDeadline, ''),
        formatDateValue(record.completionDeadline, ''),
        formatDateValue(record.completedOn, ''),
      ]
    : [
        record.honorType,
        record.level,
        record.issuingOrg,
        record.documentNo,
        record.personalRole,
        record.evidenceLocation,
      ];
  return normaliseForSearch([...common, ...specific].filter(Boolean).join(' '));
}

function matchesStatusBucket(
  record: AnyRecord,
  bucket: StatusBucket,
  verdictOf: (r: WorkRecord) => DeadlineVerdict,
): boolean {
  if (bucket === 'all') return true;
  // Honours have no work status. They are only ever included by `all`, so that a status filter
  // cannot silently mix them in — the legacy `renderTabCounts()` counted honours into `all`
  // while the dashboard's "工作记录" tile subtracted them, and the two numbers disagreed.
  if (!isWorkRecord(record)) return false;

  switch (bucket) {
    case 'open':
      return record.status !== 'completed' && record.status !== 'cancelled';
    case 'long-term':
      return record.longTerm;
    case 'overdue': {
      const v = verdictOf(record);
      return v.level === 'overdue' && !isStaleBacklog(v);
    }
    case 'stale-backlog':
      return isStaleBacklog(verdictOf(record));
    case 'todo':
    case 'in-progress':
    case 'completed':
    case 'cancelled':
    case 'deferred':
      return record.status === bucket;
  }
}

/** A bucket that is exactly one canonical status, for label lookups. */
export function statusBucketAsStatus(bucket: StatusBucket): WorkStatus | null {
  return isWorkStatus(bucket) ? bucket : null;
}

function matchesDateWindow(record: AnyRecord, query: RecordQuery): boolean {
  const date = primaryDate(record);

  if (query.onDay !== null) {
    return overlapsWindow(date, query.onDay, nextDay(query.onDay));
  }

  if (query.dateFrom !== null || query.dateTo !== null) {
    const from = query.dateFrom ?? '0001-01-01';
    const toExclusive = query.dateTo !== null ? nextDay(query.dateTo) : '9999-12-31';
    if (!overlapsWindow(date, from, toExclusive)) return false;
  }

  if (query.year !== null && yearOf(date) !== query.year) return false;
  if (query.month !== null && monthOf(date) !== query.month) return false;
  return true;
}

/** Day after an ISO date, as a string. Used to turn inclusive bounds into half-open windows. */
export function nextDay(iso: IsoDate): IsoDate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const next = new Date(y, m - 1, d + 1);
  const yy = String(next.getFullYear()).padStart(4, '0');
  const mm = String(next.getMonth() + 1).padStart(2, '0');
  const dd = String(next.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Soft-delete and record-kind gates. */
function matchesLifecycle(record: AnyRecord, query: RecordQuery): boolean {
  if (!query.includeDeleted && record.deletedAt !== null) return false;
  return query.kind === 'all' || record.kind === query.kind;
}

/** Category, group, counterpart unit and honour level. */
function matchesAssociations(record: AnyRecord, query: RecordQuery): boolean {
  if (query.categoryId !== null) {
    if (!isWorkRecord(record) || record.categoryId !== query.categoryId) return false;
  }
  if (query.groupId !== null) {
    if (!isWorkRecord(record) || record.groupId !== query.groupId) return false;
  }
  if (query.unit !== null) {
    const unit = isWorkRecord(record) ? record.counterpartUnit : record.issuingOrg;
    if (unit !== query.unit) return false;
  }
  if (query.honorLevel !== null) {
    if (isWorkRecord(record) || record.level !== query.honorLevel) return false;
  }
  return true;
}

export interface QueryContext {
  readonly today: IsoDate;
}

/**
 * Apply a query. Filters compose with AND; none resets another.
 * `verdictCache` keeps deadline evaluation to one pass per record per call.
 */
export function runQuery(
  records: readonly AnyRecord[],
  query: RecordQuery,
  context: QueryContext = { today: todayIso() },
): AnyRecord[] {
  const verdicts = new Map<string, DeadlineVerdict>();
  const verdictOf = (record: WorkRecord): DeadlineVerdict => {
    const cached = verdicts.get(record.id);
    if (cached) return cached;
    const fresh = evaluateDeadline(record, context.today);
    verdicts.set(record.id, fresh);
    return fresh;
  };

  const needle = normaliseForSearch(query.search);

  const filtered = records.filter(
    (record) =>
      matchesLifecycle(record, query) &&
      matchesStatusBucket(record, query.statusBucket, verdictOf) &&
      matchesAssociations(record, query) &&
      matchesDateWindow(record, query) &&
      (needle === '' || searchableText(record).includes(needle)),
  );

  return sortRecords(filtered, query.sort, verdictOf);
}

export function sortRecords(
  records: readonly AnyRecord[],
  sort: SortKey,
  verdictOf: (record: WorkRecord) => DeadlineVerdict,
): AnyRecord[] {
  const out = [...records];
  const dayKey = (record: AnyRecord): string => anchorDay(primaryDate(record)) ?? '';
  // Records without a structured date sort last in both directions rather than clumping at one
  // end, so a free-text-dated row is never mistaken for the newest or the oldest item.
  const undated = (record: AnyRecord): boolean => dayKey(record) === '';

  const byUrgency = (a: AnyRecord, b: AnyRecord): number => {
    const wa = isWorkRecord(a) ? URGENCY_WEIGHT[verdictOf(a).level] : URGENCY_WEIGHT.closed;
    const wb = isWorkRecord(b) ? URGENCY_WEIGHT[verdictOf(b).level] : URGENCY_WEIGHT.closed;
    return wa - wb;
  };

  out.sort((a, b) => {
    switch (sort) {
      case 'date-asc':
      case 'date-desc': {
        if (undated(a) !== undated(b)) return undated(a) ? 1 : -1;
        const cmp = dayKey(a).localeCompare(dayKey(b));
        const primary = sort === 'date-asc' ? cmp : -cmp;
        return primary !== 0 ? primary : a.title.localeCompare(b.title, 'zh-Hans-CN');
      }
      case 'urgency': {
        const cmp = byUrgency(a, b);
        if (cmp !== 0) return cmp;
        return dayKey(a).localeCompare(dayKey(b));
      }
      case 'overdue-desc': {
        const oa = isWorkRecord(a) ? overdueDays(verdictOf(a)) : 0;
        const ob = isWorkRecord(b) ? overdueDays(verdictOf(b)) : 0;
        return ob - oa;
      }
      case 'title-asc':
        return a.title.localeCompare(b.title, 'zh-Hans-CN');
      case 'updated-desc':
        return b.updatedAt.localeCompare(a.updatedAt);
    }
  });
  return out;
}

/** Records to surface on the dashboard, in priority order. */
export function followUpList(
  records: readonly AnyRecord[],
  context: QueryContext = { today: todayIso() },
): WorkRecord[] {
  const out: WorkRecord[] = [];
  for (const record of records) {
    if (record.deletedAt !== null || !isWorkRecord(record)) continue;
    const verdict = evaluateDeadline(record, context.today);
    if (needsFollowUp(record, verdict)) out.push(record);
  }
  const verdictOf = (r: WorkRecord): DeadlineVerdict => evaluateDeadline(r, context.today);
  return sortRecords(out, 'urgency', verdictOf) as WorkRecord[];
}

/** Distinct counterpart units / issuing bodies present in the data, for filter options. */
export function distinctUnits(records: readonly AnyRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.deletedAt !== null) continue;
    const unit = isWorkRecord(record) ? record.counterpartUnit : record.issuingOrg;
    const trimmed = unit.trim();
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * Distinct years present, newest first. Only structured dates contribute, so a free-text date
 * can never produce a bogus year option — the defect the legacy ledger view had.
 */
export function distinctYears(records: readonly AnyRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.deletedAt !== null) continue;
    const year = yearOf(primaryDate(record));
    if (year) seen.add(year);
  }
  return [...seen].sort().reverse();
}

/** Count of records whose date is free text, so the UI can say so instead of hiding them. */
export function countUndated(records: readonly AnyRecord[]): number {
  let n = 0;
  for (const record of records) {
    if (record.deletedAt === null && anchorDay(primaryDate(record)) === null) n += 1;
  }
  return n;
}
