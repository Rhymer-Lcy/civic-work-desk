import { differenceInCalendarDays, isValid as isValidDate } from 'date-fns';

/**
 * The date model.
 *
 * The legacy prototype stored every temporal field as a bare string and then pushed it
 * through `new Date(...)`. Three failures followed from that, all observed in the real data:
 *
 *   1. `new Date('1月')` is `Invalid Date`; the record silently vanished from reports.
 *   2. `new Date('2026-01-04')` is parsed as **UTC** midnight, while the report window was
 *      built from local-midnight `new Date(y, m, 1)`. In any negative-UTC-offset timezone a
 *      record dated the 1st of a month fell into the previous month.
 *   3. Free text such as `待定（4月前）` or `3月5日12时前` carried real operational meaning and
 *      had nowhere to live once coerced.
 *
 * `DateValue` is therefore an explicit tagged union. Nothing is ever coerced: a value we
 * cannot prove is a calendar date is preserved verbatim as `text`, and the caller is told.
 *
 * Invariants
 * ----------
 * - A `plain` date is always a real calendar day in `YYYY-MM-DD` form (2026-02-30 is rejected).
 * - A `range` always satisfies `start <= end`.
 * - `text` is never empty (an empty input yields `absent`).
 * - Arithmetic on dates is **date-only and local**. No UTC conversion happens anywhere.
 */

export type IsoDate = string;

export type DateValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'plain'; readonly date: IsoDate }
  | { readonly kind: 'range'; readonly start: IsoDate; readonly end: IsoDate }
  | { readonly kind: 'text'; readonly text: string };

export const ABSENT_DATE: DateValue = Object.freeze({ kind: 'absent' });

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const LOOSE_YMD = /^(\d{4})[./](\d{1,2})[./](\d{1,2})$/;
const CJK_YMD = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/;
const CJK_YM = /^(\d{4})\s*年\s*(\d{1,2})\s*月$/;

/** Why a value could not be stored as a structured date. Surfaced during import. */
export type DateParseReason =
  'not-a-date' | 'impossible-calendar-date' | 'year-missing' | 'reordered-separators';

export interface DateParseResult {
  readonly value: DateValue;
  /** Present when information was preserved as text rather than structured. */
  readonly reason?: DateParseReason;
  /** True when the input was structured but had to be rewritten into canonical form. */
  readonly normalised?: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Days in a month, 1-indexed month. Handles leap years. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2999) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  return isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function makeIsoDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Convert an ISO date-only string to a `Date` at **local** midnight.
 * This is the only bridge from our string model to `Date`, and it never uses UTC parsing.
 */
export function toLocalDate(iso: IsoDate): Date {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`not an ISO date: ${iso}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Today's business date in the machine's local timezone, as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): IsoDate {
  return makeIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Whole calendar days from `from` to `to`. Negative means `to` is in the past.
 * Date-only and DST-safe: `differenceInCalendarDays` compares local calendar days, so a
 * spring-forward boundary (23h apart) still reports 1 day.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return differenceInCalendarDays(toLocalDate(to), toLocalDate(from));
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse an arbitrary legacy value into a `DateValue`, losslessly.
 *
 * Recognised, in order:
 *   `YYYY-MM-DD`            -> plain
 *   `YYYY/M/D`, `YYYY.M.D`  -> plain (normalised; flagged)
 *   `YYYY年M月D日`           -> plain (normalised; flagged)
 *   `YYYY-MM`, `YYYY年M月`   -> range covering that whole month
 * Everything else is preserved as `text` with a reason, including `2026-02-30`
 * (an impossible day is never silently shifted to March 2nd).
 */
export function parseLegacyDate(input: unknown): DateParseResult {
  if (input === null || input === undefined) return { value: ABSENT_DATE };
  if (typeof input === 'number') {
    // A number here is an Excel serial or an epoch millisecond value. Both are ambiguous
    // and neither is safe to guess, so preserve it for a human to adjudicate.
    return { value: { kind: 'text', text: String(input) }, reason: 'not-a-date' };
  }
  if (typeof input !== 'string') return { value: ABSENT_DATE };

  const raw = input.trim();
  if (raw === '') return { value: ABSENT_DATE };

  const iso = ISO_DATE.exec(raw);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (isRealCalendarDate(y, m, d))
      return { value: { kind: 'plain', date: makeIsoDate(y, m, d) } };
    return { value: { kind: 'text', text: raw }, reason: 'impossible-calendar-date' };
  }

  for (const pattern of [LOOSE_YMD, CJK_YMD]) {
    const hit = pattern.exec(raw);
    if (!hit) continue;
    const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (isRealCalendarDate(y, m, d)) {
      return { value: { kind: 'plain', date: makeIsoDate(y, m, d) }, normalised: true };
    }
    return { value: { kind: 'text', text: raw }, reason: 'impossible-calendar-date' };
  }

  for (const pattern of [ISO_MONTH, CJK_YM]) {
    const hit = pattern.exec(raw);
    if (!hit) continue;
    const [y, m] = [Number(hit[1]), Number(hit[2])];
    if (m >= 1 && m <= 12 && y >= 1900 && y <= 2999) {
      return {
        value: {
          kind: 'range',
          start: makeIsoDate(y, m, 1),
          end: makeIsoDate(y, m, daysInMonth(y, m)),
        },
        normalised: pattern === CJK_YM,
      };
    }
    return { value: { kind: 'text', text: raw }, reason: 'impossible-calendar-date' };
  }

  // `3月5日`, `1月`, `4日14日`: a real date is implied but the year is not recoverable from
  // the value itself, and inferring it from a sibling field would be a guess. Preserve it.
  const yearless = /^\s*\d{1,2}\s*[月日]/.test(raw);
  return {
    value: { kind: 'text', text: raw },
    reason: yearless ? 'year-missing' : 'not-a-date',
  };
}

/** Build a `DateValue` from a structured form control, rejecting anything not a real day. */
export function dateValueFromInput(iso: string): DateValue {
  const trimmed = iso.trim();
  if (trimmed === '') return ABSENT_DATE;
  return isIsoDate(trimmed) ? { kind: 'plain', date: trimmed } : { kind: 'text', text: trimmed };
}

export function dateValueFromRange(start: string, end: string): DateValue {
  const s = start.trim();
  const e = end.trim();
  if (!isIsoDate(s) || !isIsoDate(e)) return dateValueFromInput(s || e);
  return s <= e ? { kind: 'range', start: s, end: e } : { kind: 'range', start: e, end: s };
}

export function textDateValue(text: string): DateValue {
  const t = text.trim();
  return t === '' ? ABSENT_DATE : { kind: 'text', text: t };
}

export function hasDate(value: DateValue): boolean {
  return value.kind === 'plain' || value.kind === 'range';
}

/**
 * The single day a `DateValue` should be judged against.
 * For a range this is the **end**: a task whose window is "1–31 March" is not late on the 2nd.
 */
export function effectiveDay(value: DateValue): IsoDate | null {
  switch (value.kind) {
    case 'plain':
      return value.date;
    case 'range':
      return value.end;
    default:
      return null;
  }
}

/** The earliest day a `DateValue` touches; used for chronological sorting and bucketing. */
export function anchorDay(value: DateValue): IsoDate | null {
  switch (value.kind) {
    case 'plain':
      return value.date;
    case 'range':
      return value.start;
    default:
      return null;
  }
}

/** True when the value overlaps the half-open window `[startIso, endIsoExclusive)`. */
export function overlapsWindow(
  value: DateValue,
  startIso: IsoDate,
  endIsoExclusive: IsoDate,
): boolean {
  switch (value.kind) {
    case 'plain':
      return value.date >= startIso && value.date < endIsoExclusive;
    case 'range':
      return value.start < endIsoExclusive && value.end >= startIso;
    default:
      return false;
  }
}

export function formatDateValue(value: DateValue, absentLabel = '—'): string {
  switch (value.kind) {
    case 'absent':
      return absentLabel;
    case 'plain':
      return value.date;
    case 'range':
      return `${value.start} ~ ${value.end}`;
    case 'text':
      return value.text;
  }
}

/** The `YYYY` bucket a record belongs to, or null when it has no structured date. */
export function yearOf(value: DateValue): string | null {
  const day = anchorDay(value);
  return day ? day.slice(0, 4) : null;
}

/** The `MM` bucket a record belongs to, or null when it has no structured date. */
export function monthOf(value: DateValue): string | null {
  const day = anchorDay(value);
  return day ? day.slice(5, 7) : null;
}

/** Guard used at the storage boundary; a stored value that fails this is a schema bug. */
export function isWellFormedDateValue(value: DateValue): boolean {
  switch (value.kind) {
    case 'absent':
      return true;
    case 'plain':
      return isIsoDate(value.date);
    case 'range':
      return isIsoDate(value.start) && isIsoDate(value.end) && value.start <= value.end;
    case 'text':
      return typeof value.text === 'string' && value.text.trim() !== '';
  }
}

/** Defensive check for a `Date` that escaped from a third party (e.g. a file picker). */
export function isUsableDate(d: Date): boolean {
  return isValidDate(d);
}
