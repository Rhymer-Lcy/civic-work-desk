import { daysInMonth, makeIsoDate, overlapsWindow, todayIso } from './dates';
import type { IsoDate } from './dates';
import { evaluateDeadline, isStaleBacklog } from './deadlines';
import { STATUS_LABELS_ZH, WORK_STATUSES } from './status';
import type { WorkStatus } from './status';
import { isWorkRecord, primaryDate } from './types';
import type { AnyRecord, BusinessCategory, HonorRecord, WorkRecord } from './types';

/**
 * Report period selection and statistics.
 *
 * The legacy report module was written against a schema that did not exist. `parseWorkDate()`
 * read `w.completedTime`, `w.time` and `w.status` — none of which are fields — and never read
 * `w.date`, the record's actual date. In practice it fell through to `createdAt`, which
 * `normalizeRecord()` had set to `new Date(r.date).getTime()`; so:
 *   - a record with a free-text date had `createdAt === NaN` and was missing from every report;
 *   - a record with a reporting deadline in a later month was filed under that later month,
 *     because `deadline` was tried before `createdAt`;
 *   - `buildSummary()` counted a record as done whenever `w.done` was a non-empty string, so
 *     `取消`, `推迟`, `未完成` and `进行中` all counted as completed and the printed completion
 *     rate was simply wrong.
 *
 * Here the period is a half-open window of ISO day strings, membership is decided by the
 * record's own primary date, and every count derives from the canonical status enum.
 */

export type PeriodType = 'month' | 'quarter' | 'year';

export interface ReportPeriod {
  readonly type: PeriodType;
  /** Human label, e.g. `2026年9月` / `2026年第3季度` / `2026年度`. */
  readonly label: string;
  /** Inclusive first day. */
  readonly start: IsoDate;
  /** Exclusive last day. */
  readonly endExclusive: IsoDate;
}

function firstOfMonth(year: number, month: number): IsoDate {
  return makeIsoDate(year, month, 1);
}

/** Start of the month `offset` months after (year, month), normalising the year rollover. */
function monthStartOffset(year: number, month: number, offset: number): IsoDate {
  const zeroBased = month - 1 + offset;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12;
  return firstOfMonth(y, m + 1);
}

export function monthPeriod(year: number, month: number): ReportPeriod {
  return {
    type: 'month',
    label: `${year}年${month}月`,
    start: firstOfMonth(year, month),
    endExclusive: monthStartOffset(year, month, 1),
  };
}

export function quarterPeriod(year: number, quarter: number): ReportPeriod {
  const startMonth = (quarter - 1) * 3 + 1;
  return {
    type: 'quarter',
    label: `${year}年第${quarter}季度`,
    start: firstOfMonth(year, startMonth),
    endExclusive: monthStartOffset(year, startMonth, 3),
  };
}

export function yearPeriod(year: number): ReportPeriod {
  return {
    type: 'year',
    label: `${year}年度`,
    start: firstOfMonth(year, 1),
    endExclusive: firstOfMonth(year + 1, 1),
  };
}

export function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

/** Last day of a period, inclusive — for display, since `endExclusive` is not a real day. */
export function periodLastDay(period: ReportPeriod): IsoDate {
  const [y, m] = period.endExclusive.split('-').map(Number) as [number, number, number];
  const prevMonthZero = m - 2;
  const year = prevMonthZero < 0 ? y - 1 : y;
  const month = (((prevMonthZero % 12) + 12) % 12) + 1;
  return makeIsoDate(year, month, daysInMonth(year, month));
}

/**
 * Build a period from the form controls.
 * `monthValue` is an `<input type="month">` value (`YYYY-MM`); `yearValue` is a 4-digit string.
 */
export function periodFromSelection(
  type: PeriodType,
  monthValue: string,
  yearValue: string,
): ReportPeriod | null {
  if (type === 'year') {
    const year = Number(yearValue);
    if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
    return yearPeriod(year);
  }
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || year < 1900 || year > 2999) return null;
  return type === 'month' ? monthPeriod(year, month) : quarterPeriod(year, quarterOfMonth(month));
}

/**
 * Records belonging to a period, decided by the record's own primary date.
 * A record with no structured date is **not** silently dropped — see `undatedInScope`.
 */
export function recordsInPeriod(records: readonly AnyRecord[], period: ReportPeriod): AnyRecord[] {
  return records.filter(
    (record) =>
      record.deletedAt === null &&
      overlapsWindow(primaryDate(record), period.start, period.endExclusive),
  );
}

/**
 * Records excluded from a period only because their date is unstructured.
 * Reports show this count explicitly rather than pretending the data is complete.
 */
export function undatedInScope(records: readonly AnyRecord[]): AnyRecord[] {
  return records.filter((record) => {
    if (record.deletedAt !== null) return false;
    const kind = primaryDate(record).kind;
    return kind === 'text';
  });
}

export interface ReportSummary {
  readonly total: number;
  readonly workTotal: number;
  readonly honorTotal: number;
  /** Count per canonical status; keys are exhaustive so a zero is a real zero. */
  readonly byStatus: Readonly<Record<WorkStatus, number>>;
  /** Open work whose driving deadline has passed, excluding historical backlog. */
  readonly overdue: number;
  /** Open work overdue by more than 30 days. Reported separately, never folded into `overdue`. */
  readonly staleBacklog: number;
  readonly longTerm: number;
  /** Completed / (completed + open). Cancelled work is excluded from the denominator. */
  readonly completionRate: number | null;
  readonly byCategory: readonly CategoryCount[];
  readonly byHonorLevel: readonly LabelCount[];
  /** Records whose date is free text and so could not be placed in the period. */
  readonly undatedExcluded: number;
}

export interface CategoryCount {
  readonly categoryId: string | null;
  readonly name: string;
  readonly count: number;
}

export interface LabelCount {
  readonly label: string;
  readonly count: number;
}

function emptyStatusCounts(): Record<WorkStatus, number> {
  const out = {} as Record<WorkStatus, number>;
  for (const status of WORK_STATUSES) out[status] = 0;
  return out;
}

/**
 * Summarise a record set.
 *
 * `today` is a parameter, not `new Date()` inside the function, so a report is reproducible
 * and its overdue counts can be tested against fixed dates.
 */
export function summarise(
  records: readonly AnyRecord[],
  categories: readonly BusinessCategory[],
  options: { readonly today?: IsoDate; readonly undatedExcluded?: number } = {},
): ReportSummary {
  const today = options.today ?? todayIso();
  const byStatus = emptyStatusCounts();
  const categoryCounts = new Map<string | null, number>();
  const honorLevelCounts = new Map<string, number>();

  let workTotal = 0;
  let honorTotal = 0;
  let overdue = 0;
  let staleBacklog = 0;
  let longTerm = 0;

  for (const record of records) {
    if (record.deletedAt !== null) continue;
    if (isWorkRecord(record)) {
      workTotal += 1;
      byStatus[record.status] += 1;
      if (record.longTerm) longTerm += 1;
      const verdict = evaluateDeadline(record, today);
      if (verdict.level === 'overdue') {
        if (isStaleBacklog(verdict)) staleBacklog += 1;
        else overdue += 1;
      }
      const key = record.categoryId;
      categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
    } else {
      honorTotal += 1;
      const level = record.level.trim() === '' ? '未标注' : record.level.trim();
      honorLevelCounts.set(level, (honorLevelCounts.get(level) ?? 0) + 1);
    }
  }

  const nameOf = (id: string | null): string =>
    id === null ? '未分类' : (categories.find((c) => c.id === id)?.name ?? '已删除分类');

  const byCategory: CategoryCount[] = [...categoryCounts.entries()]
    .map(([categoryId, count]) => ({ categoryId, name: nameOf(categoryId), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const byHonorLevel: LabelCount[] = [...honorLevelCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));

  const completedCount = byStatus.completed;
  const denominator = workTotal - byStatus.cancelled;

  return {
    total: workTotal + honorTotal,
    workTotal,
    honorTotal,
    byStatus,
    overdue,
    staleBacklog,
    longTerm,
    completionRate: denominator > 0 ? completedCount / denominator : null,
    byCategory,
    byHonorLevel,
    undatedExcluded: options.undatedExcluded ?? 0,
  };
}

/** Rendered as a percentage with one decimal, or an explicit dash when undefined. */
export function formatCompletionRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function statusBreakdownLines(summary: ReportSummary): readonly LabelCount[] {
  return WORK_STATUSES.map((status) => ({
    label: STATUS_LABELS_ZH[status],
    count: summary.byStatus[status],
  }));
}

/** Work and honour records of a period, split and chronologically ordered, for exporters. */
export interface PeriodContent {
  readonly period: ReportPeriod;
  readonly work: readonly WorkRecord[];
  readonly honors: readonly HonorRecord[];
  readonly summary: ReportSummary;
}
