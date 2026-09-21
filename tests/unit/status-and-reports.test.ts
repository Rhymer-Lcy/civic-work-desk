import { describe, expect, it } from 'vitest';
import {
  isOpenStatus,
  isTerminalStatus,
  mapLegacyStatus,
  participatesInUrgency,
} from '@/domain/status';
import {
  formatCompletionRate,
  monthPeriod,
  periodFromSelection,
  periodLastDay,
  quarterOfMonth,
  quarterPeriod,
  recordsInPeriod,
  summarise,
  undatedInScope,
  yearPeriod,
} from '@/domain/reports';
import { defaultCategories } from '@/domain/defaults';
import { freeText, makeHonor, makeWork, plain, range } from '../fixtures/records';

describe('legacy status mapping', () => {
  it('maps every value the legacy option list offered', () => {
    expect(mapLegacyStatus('完成')).toEqual({ status: 'completed', inferred: false });
    expect(mapLegacyStatus('进行中')).toEqual({ status: 'in-progress', inferred: false });
    expect(mapLegacyStatus('取消')).toEqual({ status: 'cancelled', inferred: false });
    expect(mapLegacyStatus('推迟')).toEqual({ status: 'deferred', inferred: false });
  });

  it('maps 未完成 to todo, NOT to the cancelled bucket', () => {
    // Legacy `isOther()` matched `未完成` alongside `取消`/`推迟`, so outstanding work was filed
    // under a tab labelled "取消/推迟" and excluded from the pending count.
    expect(mapLegacyStatus('未完成')).toEqual({ status: 'todo', inferred: false });
  });

  it('treats an empty value as todo without calling it an inference', () => {
    expect(mapLegacyStatus('')).toEqual({ status: 'todo', inferred: false });
    expect(mapLegacyStatus(null)).toEqual({ status: 'todo', inferred: false });
  });

  it('matches an annotated label by prefix but flags it as inferred', () => {
    expect(mapLegacyStatus('完成（已上报）')).toEqual({ status: 'completed', inferred: true });
  });

  it('returns null for wording it cannot place, rather than guessing', () => {
    expect(mapLegacyStatus('基本完成（待复核）')).toBeNull();
    expect(mapLegacyStatus('随便写的东西')).toBeNull();
  });

  it('classifies terminal, open and urgency-bearing statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('deferred')).toBe(false);
    expect(isOpenStatus('deferred')).toBe(true);
    expect(participatesInUrgency('deferred')).toBe(true);
    expect(participatesInUrgency('completed')).toBe(false);
  });
});

describe('report periods', () => {
  it('builds a month as a half-open window', () => {
    const period = monthPeriod(2026, 2);
    expect(period).toMatchObject({ start: '2026-02-01', endExclusive: '2026-03-01' });
    expect(periodLastDay(period)).toBe('2026-02-28');
    expect(periodLastDay(monthPeriod(2028, 2))).toBe('2028-02-29');
  });

  it('rolls a December month over into the next year', () => {
    expect(monthPeriod(2026, 12).endExclusive).toBe('2027-01-01');
    expect(periodLastDay(monthPeriod(2026, 12))).toBe('2026-12-31');
  });

  it('builds quarters covering exactly three months', () => {
    expect(quarterOfMonth(1)).toBe(1);
    expect(quarterOfMonth(3)).toBe(1);
    expect(quarterOfMonth(4)).toBe(2);
    expect(quarterOfMonth(12)).toBe(4);
    expect(quarterPeriod(2026, 1)).toMatchObject({
      start: '2026-01-01',
      endExclusive: '2026-04-01',
    });
    expect(quarterPeriod(2026, 4)).toMatchObject({
      start: '2026-10-01',
      endExclusive: '2027-01-01',
    });
    expect(periodLastDay(quarterPeriod(2026, 4))).toBe('2026-12-31');
  });

  it('builds a full year', () => {
    expect(yearPeriod(2026)).toMatchObject({ start: '2026-01-01', endExclusive: '2027-01-01' });
  });

  it('parses the form controls, rejecting unusable input', () => {
    expect(periodFromSelection('month', '2026-09', '')).toMatchObject({ label: '2026年9月' });
    expect(periodFromSelection('quarter', '2026-08', '')).toMatchObject({ label: '2026年第3季度' });
    expect(periodFromSelection('year', '', '2026')).toMatchObject({ label: '2026年度' });
    expect(periodFromSelection('month', '', '')).toBeNull();
    expect(periodFromSelection('month', 'not-a-month', '')).toBeNull();
    expect(periodFromSelection('month', '2026-13', '')).toBeNull();
    expect(periodFromSelection('year', '', 'abc')).toBeNull();
  });
});

describe('period membership', () => {
  it('files a record by its OWN date, not by its deadline', () => {
    // The legacy `parseWorkDate()` tried `deadline` before falling through to `createdAt`, so a
    // record dated April with a November deadline was reported in November.
    const record = makeWork({
      id: 'april',
      occurredOn: plain('2026-04-16'),
      reportDeadline: plain('2026-11-30'),
    });
    expect(recordsInPeriod([record], monthPeriod(2026, 4)).map((r) => r.id)).toEqual(['april']);
    expect(recordsInPeriod([record], monthPeriod(2026, 11))).toEqual([]);
  });

  it('includes a record on the first day of the period', () => {
    // A UTC-parsed date compared against a local-midnight window put this in the previous month
    // in any negative-offset timezone.
    const first = makeWork({ id: 'first', occurredOn: plain('2026-03-01') });
    expect(recordsInPeriod([first], monthPeriod(2026, 3)).map((r) => r.id)).toEqual(['first']);
    expect(recordsInPeriod([first], monthPeriod(2026, 2))).toEqual([]);
  });

  it('excludes a record on the first day of the FOLLOWING period', () => {
    const boundary = makeWork({ occurredOn: plain('2026-04-01') });
    expect(recordsInPeriod([boundary], monthPeriod(2026, 3))).toEqual([]);
  });

  it('includes a range record that overlaps the period at all', () => {
    const spanning = makeWork({ id: 'span', occurredOn: range('2026-02-25', '2026-03-05') });
    expect(recordsInPeriod([spanning], monthPeriod(2026, 2)).map((r) => r.id)).toEqual(['span']);
    expect(recordsInPeriod([spanning], monthPeriod(2026, 3)).map((r) => r.id)).toEqual(['span']);
  });

  it('excludes free-text dates from every period but reports them separately', () => {
    const undated = makeWork({ id: 'undated', occurredOn: freeText('1月') });
    expect(recordsInPeriod([undated], yearPeriod(2026))).toEqual([]);
    expect(undatedInScope([undated]).map((r) => r.id)).toEqual(['undated']);
  });

  it('ignores soft-deleted records', () => {
    const deleted = makeWork({
      occurredOn: plain('2026-03-01'),
      deletedAt: '2026-03-02T00:00:00Z',
    });
    expect(recordsInPeriod([deleted], monthPeriod(2026, 3))).toEqual([]);
  });
});

describe('summarise', () => {
  const categories = defaultCategories();
  const today = '2026-09-21';

  it('counts completion from the canonical status, not from a non-empty label', () => {
    // The legacy `buildSummary()` used `w.done` truthiness, so 取消 / 推迟 / 未完成 / 进行中 all
    // counted as completed and the printed completion rate was simply wrong.
    const records = [
      makeWork({ status: 'completed' }),
      makeWork({ status: 'in-progress' }),
      makeWork({ status: 'cancelled' }),
      makeWork({ status: 'deferred' }),
      makeWork({ status: 'todo' }),
    ];
    const summary = summarise(records, categories, { today });
    expect(summary.byStatus).toEqual({
      todo: 1,
      'in-progress': 1,
      completed: 1,
      cancelled: 1,
      deferred: 1,
    });
    // Denominator excludes the cancelled item: 1 of 4, not 4 of 5.
    expect(summary.completionRate).toBeCloseTo(0.25, 10);
    expect(formatCompletionRate(summary.completionRate)).toBe('25.0%');
  });

  it('returns a null completion rate rather than 0% when there is nothing to divide', () => {
    const summary = summarise([makeHonor()], categories, { today });
    expect(summary.completionRate).toBeNull();
    expect(formatCompletionRate(null)).toBe('—');
  });

  it('separates overdue from stale backlog and never merges them', () => {
    const records = [
      makeWork({ reportDeadline: plain('2026-09-15') }),
      makeWork({ reportDeadline: plain('2026-01-01') }),
    ];
    const summary = summarise(records, categories, { today });
    expect(summary.overdue).toBe(1);
    expect(summary.staleBacklog).toBe(1);
  });

  it('never counts a completed record as overdue', () => {
    const records = [makeWork({ status: 'completed', reportDeadline: plain('2026-01-01') })];
    expect(summarise(records, categories, { today }).overdue).toBe(0);
  });

  it('counts work and honours separately and totals them', () => {
    const summary = summarise([makeWork(), makeWork(), makeHonor()], categories, { today });
    expect(summary.workTotal).toBe(2);
    expect(summary.honorTotal).toBe(1);
    expect(summary.total).toBe(3);
  });

  it('resolves category names and labels a deleted category rather than dropping it', () => {
    const known = categories[0];
    expect(known).toBeDefined();
    const records = [
      makeWork({ categoryId: known?.id ?? null }),
      makeWork({ categoryId: 'cat-that-no-longer-exists' }),
      makeWork({ categoryId: null }),
    ];
    const summary = summarise(records, categories, { today });
    const names = summary.byCategory.map((row) => row.name).sort();
    expect(names).toContain(known?.name);
    expect(names).toContain('已删除分类');
    expect(names).toContain('未分类');
  });

  it('groups honours by level and labels a blank level explicitly', () => {
    const summary = summarise(
      [makeHonor({ level: '省级' }), makeHonor({ level: '省级' }), makeHonor({ level: '' })],
      categories,
      { today },
    );
    expect(summary.byHonorLevel).toEqual([
      { label: '省级', count: 2 },
      { label: '未标注', count: 1 },
    ]);
  });

  it('carries the excluded-undated count through to the report', () => {
    const summary = summarise([makeWork()], categories, { today, undatedExcluded: 7 });
    expect(summary.undatedExcluded).toBe(7);
  });
});
