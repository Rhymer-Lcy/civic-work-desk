import { describe, expect, it } from 'vitest';
import {
  ABSENT_DATE,
  anchorDay,
  compareIsoDate,
  dateValueFromRange,
  daysBetween,
  daysInMonth,
  effectiveDay,
  formatDateValue,
  isIsoDate,
  isRealCalendarDate,
  isWellFormedDateValue,
  makeIsoDate,
  monthOf,
  overlapsWindow,
  parseLegacyDate,
  toLocalDate,
  todayIso,
  yearOf,
} from '@/domain/dates';

describe('calendar arithmetic', () => {
  it('knows month lengths including February in leap and common years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    // Century rule: divisible by 100 is not a leap year unless also by 400.
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('rejects impossible calendar dates rather than rolling them over', () => {
    expect(isRealCalendarDate(2026, 2, 30)).toBe(false);
    expect(isRealCalendarDate(2026, 2, 29)).toBe(false);
    expect(isRealCalendarDate(2028, 2, 29)).toBe(true);
    expect(isRealCalendarDate(2026, 13, 1)).toBe(false);
    expect(isRealCalendarDate(2026, 0, 1)).toBe(false);
    expect(isRealCalendarDate(2026, 4, 31)).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-2-8')).toBe(false);
  });

  it('parses ISO dates at LOCAL midnight, never UTC', () => {
    const d = toLocalDate('2026-01-04');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
  });

  it('counts whole calendar days across month and year boundaries', () => {
    expect(daysBetween('2026-09-21', '2026-09-21')).toBe(0);
    expect(daysBetween('2026-09-21', '2026-09-22')).toBe(1);
    expect(daysBetween('2026-09-22', '2026-09-21')).toBe(-1);
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2); // leap year
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1); // common year
  });

  it('counts calendar days across a DST transition as whole days', () => {
    // US DST springs forward on 2026-03-08 and falls back on 2026-11-01. Those local days are
    // 23 and 25 hours long; a millisecond-difference implementation returns 0.958 / 1.041 and
    // rounds inconsistently. `differenceInCalendarDays` compares calendar days, so both are 1.
    expect(daysBetween('2026-03-07', '2026-03-08')).toBe(1);
    expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1);
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
    // And a whole month spanning a transition.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30);
  });

  it('orders ISO dates lexicographically, which is chronological', () => {
    expect(compareIsoDate('2026-01-02', '2026-01-10')).toBe(-1);
    expect(compareIsoDate('2026-01-10', '2026-01-02')).toBe(1);
    expect(compareIsoDate('2026-01-02', '2026-01-02')).toBe(0);
  });

  it('derives today from local calendar fields', () => {
    expect(todayIso(new Date(2026, 8, 21, 23, 59))).toBe('2026-09-21');
    expect(todayIso(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    expect(makeIsoDate(2026, 3, 7)).toBe('2026-03-07');
  });
});

describe('parseLegacyDate', () => {
  it('accepts a clean ISO date', () => {
    const result = parseLegacyDate('2026-01-04');
    expect(result.value).toEqual({ kind: 'plain', date: '2026-01-04' });
    expect(result.reason).toBeUndefined();
    expect(result.normalised).toBeUndefined();
  });

  it('treats empty, null and undefined as absent', () => {
    expect(parseLegacyDate('').value).toEqual(ABSENT_DATE);
    expect(parseLegacyDate('   ').value).toEqual(ABSENT_DATE);
    expect(parseLegacyDate(null).value).toEqual(ABSENT_DATE);
    expect(parseLegacyDate(undefined).value).toEqual(ABSENT_DATE);
  });

  it('preserves a month-only Chinese date as text and says the year is missing', () => {
    // The real defect: `new Date('1月')` is Invalid Date, and the record vanished from reports.
    const result = parseLegacyDate('1月');
    expect(result.value).toEqual({ kind: 'text', text: '1月' });
    expect(result.reason).toBe('year-missing');
  });

  it('preserves a malformed day/day typo verbatim', () => {
    const result = parseLegacyDate('4日14日');
    expect(result.value).toEqual({ kind: 'text', text: '4日14日' });
    expect(result.reason).toBe('year-missing');
  });

  it('preserves an impossible calendar date instead of shifting it', () => {
    const result = parseLegacyDate('2026-02-30');
    expect(result.value).toEqual({ kind: 'text', text: '2026-02-30' });
    expect(result.reason).toBe('impossible-calendar-date');
    // The point of the test: it must NOT become 2026-03-02.
    expect(formatDateValue(result.value)).toBe('2026-02-30');
  });

  it('normalises unambiguous non-canonical forms and flags the rewrite', () => {
    for (const input of ['2026/9/7', '2026.9.7', '2026年9月7日', '2026年9月7']) {
      const result = parseLegacyDate(input);
      expect(result.value).toEqual({ kind: 'plain', date: '2026-09-07' });
      expect(result.normalised).toBe(true);
    }
  });

  it('expands a year-month value into a range covering that whole month', () => {
    expect(parseLegacyDate('2026-02').value).toEqual({
      kind: 'range',
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(parseLegacyDate('2028-02').value).toEqual({
      kind: 'range',
      start: '2028-02-01',
      end: '2028-02-29',
    });
    expect(parseLegacyDate('2026年4月').value).toEqual({
      kind: 'range',
      start: '2026-04-01',
      end: '2026-04-30',
    });
  });

  it('preserves free-text deadlines exactly as written', () => {
    for (const input of ['待定（4月前）', '3月5日12时前', '长期推进', '每月例行', '本周内']) {
      const result = parseLegacyDate(input);
      expect(result.value).toEqual({ kind: 'text', text: input });
      expect(formatDateValue(result.value)).toBe(input);
    }
  });

  it('never interprets a bare number as a date', () => {
    const result = parseLegacyDate(46100);
    expect(result.value).toEqual({ kind: 'text', text: '46100' });
    expect(result.reason).toBe('not-a-date');
  });
});

describe('DateValue accessors', () => {
  it('uses the END of a range as the day to judge against', () => {
    const value = { kind: 'range', start: '2026-03-01', end: '2026-03-31' } as const;
    expect(effectiveDay(value)).toBe('2026-03-31');
    expect(anchorDay(value)).toBe('2026-03-01');
  });

  it('returns null for text and absent values', () => {
    expect(effectiveDay({ kind: 'text', text: '待定' })).toBeNull();
    expect(anchorDay(ABSENT_DATE)).toBeNull();
    expect(yearOf({ kind: 'text', text: '1月' })).toBeNull();
    expect(monthOf(ABSENT_DATE)).toBeNull();
  });

  it('buckets structured dates by year and month', () => {
    expect(yearOf({ kind: 'plain', date: '2026-09-21' })).toBe('2026');
    expect(monthOf({ kind: 'plain', date: '2026-09-21' })).toBe('09');
    expect(yearOf({ kind: 'range', start: '2025-12-30', end: '2026-01-02' })).toBe('2025');
  });

  it('tests window overlap with a half-open interval', () => {
    const day = { kind: 'plain', date: '2026-03-01' } as const;
    expect(overlapsWindow(day, '2026-03-01', '2026-04-01')).toBe(true);
    expect(overlapsWindow(day, '2026-02-01', '2026-03-01')).toBe(false);
    const span = { kind: 'range', start: '2026-02-25', end: '2026-03-05' } as const;
    expect(overlapsWindow(span, '2026-03-01', '2026-04-01')).toBe(true);
    expect(overlapsWindow(span, '2026-02-01', '2026-03-01')).toBe(true);
    expect(overlapsWindow(span, '2026-04-01', '2026-05-01')).toBe(false);
    expect(overlapsWindow({ kind: 'text', text: '1月' }, '2026-01-01', '2026-02-01')).toBe(false);
  });

  it('orders a range so start never follows end', () => {
    expect(dateValueFromRange('2026-03-31', '2026-03-01')).toEqual({
      kind: 'range',
      start: '2026-03-01',
      end: '2026-03-31',
    });
  });

  it('degrades an incomplete range to whichever single day is present', () => {
    expect(dateValueFromRange('2026-03-01', '')).toEqual({ kind: 'plain', date: '2026-03-01' });
    expect(dateValueFromRange('', '')).toEqual(ABSENT_DATE);
  });

  it('validates well-formedness at the storage boundary', () => {
    expect(isWellFormedDateValue(ABSENT_DATE)).toBe(true);
    expect(isWellFormedDateValue({ kind: 'plain', date: '2026-01-01' })).toBe(true);
    expect(isWellFormedDateValue({ kind: 'plain', date: '2026-02-30' })).toBe(false);
    expect(isWellFormedDateValue({ kind: 'range', start: '2026-03-31', end: '2026-03-01' })).toBe(
      false,
    );
    expect(isWellFormedDateValue({ kind: 'text', text: '  ' })).toBe(false);
  });

  it('formats every kind for display', () => {
    expect(formatDateValue(ABSENT_DATE)).toBe('—');
    expect(formatDateValue(ABSENT_DATE, '未填')).toBe('未填');
    expect(formatDateValue({ kind: 'plain', date: '2026-01-04' })).toBe('2026-01-04');
    expect(formatDateValue({ kind: 'range', start: '2026-01-01', end: '2026-01-31' })).toBe(
      '2026-01-01 ~ 2026-01-31',
    );
    expect(formatDateValue({ kind: 'text', text: '待定（4月前）' })).toBe('待定（4月前）');
  });
});
