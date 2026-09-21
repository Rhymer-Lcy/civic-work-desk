import { compareIsoDate, daysBetween, effectiveDay, formatDateValue, todayIso } from './dates';
import type { DateValue, IsoDate } from './dates';
import { participatesInUrgency } from './status';
import type { WorkRecord } from './types';

/**
 * Deadline semantics — one implementation, used by every view.
 *
 * In the legacy prototype five call sites each decided "overdue" differently:
 * `deadlineInfo()` considered both the reporting and completion deadlines, while
 * `renderStats()`, `renderTabCounts()`, `renderAlert()`, `renderToday()` and the `stale` tab
 * all re-tested urgency with `daysUntil(w.deadline)` — the *reporting* deadline only. A record
 * whose urgency came from its completion deadline was counted as overdue by one view and as
 * having no deadline by the next. The dashboard and the tab badges disagreed by construction.
 *
 * Everything below is pure: it takes a record and "today", and returns a verdict that names
 * which deadline drove it. There is no second interpretation anywhere in the codebase.
 */

export type UrgencyLevel =
  /** A driving deadline has passed. */
  | 'overdue'
  /** A driving deadline is today. */
  | 'due-today'
  /** Within `DUE_SOON_DAYS` inclusive. */
  | 'due-soon'
  /** Has a structured deadline further out. */
  | 'scheduled'
  /** Has a deadline, but only as free text we cannot compute against. */
  | 'text-only'
  /** No deadline recorded at all. */
  | 'none'
  /** Completed or cancelled: deadlines no longer apply. */
  | 'closed';

/** Which of the two deadlines produced the verdict. */
export type DeadlineSource = 'report' | 'completion';

export interface DeadlineVerdict {
  readonly level: UrgencyLevel;
  /** Null unless `level` is overdue / due-today / due-soon / scheduled. */
  readonly source: DeadlineSource | null;
  /** The day being judged against. Null when there is no structured deadline. */
  readonly day: IsoDate | null;
  /** Negative when past. Null when not computable. */
  readonly daysRemaining: number | null;
  /** Free-text deadline wording, when that is all the record has. */
  readonly textParts: readonly string[];
}

export const DUE_SOON_DAYS = 7;

/**
 * Sort weight, ascending = more pressing. Used by the "by urgency" sort and every
 * "needs attention" list so their orders cannot drift apart.
 */
export const URGENCY_WEIGHT: Readonly<Record<UrgencyLevel, number>> = Object.freeze({
  overdue: 0,
  'due-today': 1,
  'due-soon': 2,
  scheduled: 3,
  'text-only': 4,
  none: 5,
  closed: 6,
});

export const URGENCY_LABELS_ZH: Readonly<Record<UrgencyLevel, string>> = Object.freeze({
  overdue: '已逾期',
  'due-today': '今日到期',
  'due-soon': '即将到期',
  scheduled: '已排期',
  'text-only': '文字时限',
  none: '未设时限',
  closed: '已结束',
});

export const DEADLINE_SOURCE_LABELS_ZH: Readonly<Record<DeadlineSource, string>> = Object.freeze({
  report: '上报时限',
  completion: '完成时限',
});

interface Candidate {
  readonly source: DeadlineSource;
  readonly day: IsoDate;
}

function collectCandidates(record: WorkRecord): Candidate[] {
  const out: Candidate[] = [];
  const report = effectiveDay(record.reportDeadline);
  if (report) out.push({ source: 'report', day: report });
  const completion = effectiveDay(record.completionDeadline);
  if (completion) out.push({ source: 'completion', day: completion });
  return out;
}

function collectTextParts(record: WorkRecord): string[] {
  const parts: string[] = [];
  for (const value of [record.reportDeadline, record.completionDeadline] as const) {
    if (value.kind === 'text') parts.push(value.text);
  }
  return parts;
}

/**
 * Evaluate a work record's deadline position.
 *
 * Deliberate rules, each a correction of legacy behaviour:
 *  - Completed and cancelled records are `closed`. The legacy `deadlineInfo()` did not check
 *    status at all, so a finished item kept reporting "已逾期 N 天" in the card meta.
 *  - `deferred` still participates: putting work off does not make its deadline go away.
 *  - The earliest of the two deadlines wins, and the verdict names which one, so the UI can
 *    label it ("上报时限已逾期 3 天") instead of showing an unattributed red badge.
 *  - `longTerm` no longer suppresses urgency. If a long-term item carries a real date, that
 *    date is honest and is shown. Long-term items *without* a date land in `none` and are
 *    surfaced by `needsFollowUp` rather than disappearing.
 */
export function evaluateDeadline(record: WorkRecord, today: IsoDate = todayIso()): DeadlineVerdict {
  if (!participatesInUrgency(record.status)) {
    return { level: 'closed', source: null, day: null, daysRemaining: null, textParts: [] };
  }

  const candidates = collectCandidates(record);
  if (candidates.length > 0) {
    candidates.sort((a, b) => compareIsoDate(a.day, b.day));
    // `candidates` is non-empty, so index 0 exists; noUncheckedIndexedAccess still requires a check.
    const soonest = candidates[0];
    if (soonest) {
      const daysRemaining = daysBetween(today, soonest.day);
      const level: UrgencyLevel =
        daysRemaining < 0
          ? 'overdue'
          : daysRemaining === 0
            ? 'due-today'
            : daysRemaining <= DUE_SOON_DAYS
              ? 'due-soon'
              : 'scheduled';
      return {
        level,
        source: soonest.source,
        day: soonest.day,
        daysRemaining,
        textParts: collectTextParts(record),
      };
    }
  }

  const textParts = collectTextParts(record);
  if (textParts.length > 0) {
    return { level: 'text-only', source: null, day: null, daysRemaining: null, textParts };
  }
  return { level: 'none', source: null, day: null, daysRemaining: null, textParts: [] };
}

/**
 * How long a record has been overdue, in days. 0 when not overdue.
 * Used to separate "acted on now" from historical backlog without a second date read.
 */
export function overdueDays(verdict: DeadlineVerdict): number {
  return verdict.level === 'overdue' && verdict.daysRemaining !== null ? -verdict.daysRemaining : 0;
}

/** Overdue by more than this is treated as historical backlog, not a live alert. */
export const STALE_OVERDUE_DAYS = 30;

export function isStaleBacklog(verdict: DeadlineVerdict): boolean {
  return overdueDays(verdict) > STALE_OVERDUE_DAYS;
}

/**
 * Records that should appear in a "needs attention" list.
 *
 * Includes open long-term work with no deadline, which is the case the legacy prototype
 * dropped: `renderToday()` and `renderAlert()` both began with `if (w.longterm) return false`,
 * so a long-term item could never be surfaced for follow-up by any view except its own tab.
 */
export function needsFollowUp(record: WorkRecord, verdict: DeadlineVerdict): boolean {
  if (verdict.level === 'closed') return false;
  if (verdict.level === 'overdue') return !isStaleBacklog(verdict);
  if (verdict.level === 'due-today' || verdict.level === 'due-soon') return true;
  return record.longTerm && (verdict.level === 'none' || verdict.level === 'text-only');
}

/** Short human phrase for a verdict. Never the only signal — pair it with an icon or text tag. */
export function describeVerdict(verdict: DeadlineVerdict): string {
  switch (verdict.level) {
    case 'overdue':
      return `已逾期 ${overdueDays(verdict)} 天`;
    case 'due-today':
      return '今日到期';
    case 'due-soon':
      return `剩 ${verdict.daysRemaining ?? 0} 天`;
    case 'scheduled':
      return `剩 ${verdict.daysRemaining ?? 0} 天`;
    case 'text-only':
      return verdict.textParts.join(' / ');
    case 'none':
      return '未设时限';
    case 'closed':
      return '已结束';
  }
}

/** Full phrase including which deadline drives it, for screen readers and report text. */
export function describeVerdictWithSource(verdict: DeadlineVerdict): string {
  const base = describeVerdict(verdict);
  if (!verdict.source) return base;
  return `${DEADLINE_SOURCE_LABELS_ZH[verdict.source]}${base}`;
}

/** Formats whichever deadline value a verdict points at, for table cells. */
export function formatDeadlineFor(record: WorkRecord, source: DeadlineSource | null): string {
  const value: DateValue =
    source === 'completion' ? record.completionDeadline : record.reportDeadline;
  return formatDateValue(value);
}
