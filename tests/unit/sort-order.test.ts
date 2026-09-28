import { describe, expect, it } from 'vitest';
import { anchorDay } from '@/domain/dates';
import { URGENCY_WEIGHT, evaluateDeadline, overdueDays } from '@/domain/deadlines';
import type { DeadlineVerdict } from '@/domain/deadlines';
import { sortRecords } from '@/domain/query';
import type { SortKey } from '@/domain/query';
import { isWorkRecord, primaryDate } from '@/domain/types';
import type { AnyRecord, WorkRecord } from '@/domain/types';
import { buildSyntheticArchive } from '../perf/synthetic-archive';

/**
 * The Phase-5 comparator change must not change any order.
 *
 * `sortRecords` stopped mixing `localeCompare(b)` (default locale) and `localeCompare(b, 'zh-Hans-CN')`
 * inside one comparator, because alternating locales made the engine rebuild its collator on every
 * switch. The replacement is claimed to be exact: code-unit order for ISO day keys, and one shared
 * `Intl.Collator('zh-Hans-CN')` for titles. This pins that claim by keeping the Phase-4 comparator
 * verbatim as an oracle and comparing complete orderings, for every sort key, over the 5,000-record
 * synthetic archive — which has same-day ties between Chinese titles, ranges, free-text and absent
 * dates, and honours mixed with work.
 */

function phase4Sort(
  records: readonly AnyRecord[],
  sort: SortKey,
  verdictOf: (record: WorkRecord) => DeadlineVerdict,
): AnyRecord[] {
  const out = [...records];
  const dayKey = (record: AnyRecord): string => anchorDay(primaryDate(record)) ?? '';
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

const SORTS: readonly SortKey[] = [
  'date-desc',
  'date-asc',
  'urgency',
  'title-asc',
  'updated-desc',
  'overdue-desc',
];

describe('sortRecords keeps the Phase-4 order exactly', () => {
  const { records } = buildSyntheticArchive({ workCount: 5000 });
  const verdictOf = (record: WorkRecord): DeadlineVerdict => evaluateDeadline(record, '2026-09-28');

  it('covers the cases the comparator distinguishes', () => {
    const days = records.map((record) => anchorDay(primaryDate(record)));
    expect(days.filter((day) => day === null).length).toBeGreaterThan(100);
    // Same-day records exist, so the title tie-break is exercised many times.
    expect(new Set(days).size).toBeLessThan(records.length / 2);
    expect(records.some((record) => record.kind === 'honor')).toBe(true);
  });

  for (const sort of SORTS) {
    it(`${sort}: identical order over ${String(records.length)} records`, () => {
      const expected = phase4Sort(records, sort, verdictOf).map((record) => record.id);
      const actual = sortRecords(records, sort, verdictOf).map((record) => record.id);
      expect(actual).toEqual(expected);
    });
  }
});
