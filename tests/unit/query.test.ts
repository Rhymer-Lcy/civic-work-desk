import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUERY,
  countUndated,
  distinctUnits,
  distinctYears,
  followUpList,
  nextDay,
  normaliseForSearch,
  runQuery,
  searchableText,
} from '@/domain/query';
import type { RecordQuery } from '@/domain/query';
import { freeText, makeHonor, makeWork, plain, range } from '../fixtures/records';

const TODAY = '2026-09-21';
const ctx = { today: TODAY };

function query(overrides: Partial<RecordQuery> = {}): RecordQuery {
  return { ...EMPTY_QUERY, ...overrides };
}

describe('search normalisation', () => {
  it('collapses ASCII and full-width whitespace without touching the stored value', () => {
    expect(normaliseForSearch('  甲　　乙  ')).toBe('甲 乙');
    expect(normaliseForSearch('ABC\tdef')).toBe('abc def');
  });

  it('searches across every meaningful field of both record kinds', () => {
    const work = makeWork({
      title: '报送示范工作要点',
      requirement: '上报反馈意见',
      counterpartUnit: '示范单位甲',
      counterpartContact: '联系人甲',
      counterpartPhone: '13800130001',
      remark: '无意见',
    });
    const text = searchableText(work);
    for (const needle of ['报送', '上报反馈', '示范单位甲', '联系人甲', '13800130001', '无意见']) {
      expect(text, needle).toContain(normaliseForSearch(needle));
    }

    const honor = makeHonor({
      title: '示范感谢信',
      documentNo: '示范函〔2026〕1号',
      evidenceLocation: '档案柜示范号盒',
      personalRole: '主要承办人',
    });
    const honorText = searchableText(honor);
    for (const needle of ['示范感谢信', '示范函', '档案柜', '主要承办人']) {
      expect(honorText, needle).toContain(normaliseForSearch(needle));
    }
  });
});

describe('filter composition', () => {
  const records = [
    makeWork({
      id: 'a',
      title: '甲事项',
      categoryId: 'cat-1',
      counterpartUnit: '单位甲',
      occurredOn: plain('2026-03-05'),
      status: 'todo',
    }),
    makeWork({
      id: 'b',
      title: '乙事项',
      categoryId: 'cat-2',
      counterpartUnit: '单位乙',
      occurredOn: plain('2026-03-20'),
      status: 'completed',
    }),
    makeWork({
      id: 'c',
      title: '丙事项',
      categoryId: 'cat-1',
      counterpartUnit: '单位甲',
      occurredOn: plain('2026-09-10'),
      status: 'in-progress',
    }),
    makeHonor({
      id: 'h',
      title: '丁荣誉',
      issuingOrg: '单位丙',
      awardedOn: plain('2026-03-15'),
      level: '市级',
    }),
    makeWork({ id: 'x', title: '已删除事项', deletedAt: '2026-09-01T00:00:00.000Z' }),
  ];

  it('hides soft-deleted records by default and shows them on request', () => {
    expect(runQuery(records, query(), ctx).map((r) => r.id)).not.toContain('x');
    expect(runQuery(records, query({ includeDeleted: true }), ctx).map((r) => r.id)).toContain('x');
  });

  it('composes kind, category, unit, year and month with AND', () => {
    const result = runQuery(
      records,
      query({ kind: 'work', categoryId: 'cat-1', unit: '单位甲', year: '2026', month: '03' }),
      ctx,
    );
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('treats year and month as independent filters that still compose', () => {
    expect(
      runQuery(records, query({ month: '03' }), ctx)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', 'b', 'h']);
    expect(runQuery(records, query({ year: '2026', month: '09' }), ctx).map((r) => r.id)).toEqual([
      'c',
    ]);
  });

  it('never lets a status filter silently include honours', () => {
    // The legacy tab counter added honours to `all` while the dashboard tile subtracted them, so
    // the two figures disagreed. Here a status bucket is a work-only concept, by construction.
    const completed = runQuery(records, query({ statusBucket: 'completed' }), ctx);
    expect(completed.every((r) => r.kind === 'work')).toBe(true);
    expect(completed.map((r) => r.id)).toEqual(['b']);
  });

  it('filters honours by level and refuses to apply that filter to work', () => {
    const result = runQuery(records, query({ honorLevel: '市级' }), ctx);
    expect(result.map((r) => r.id)).toEqual(['h']);
  });

  it('applies an explicit inclusive date window', () => {
    const result = runQuery(records, query({ dateFrom: '2026-03-05', dateTo: '2026-03-15' }), ctx);
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'h']);
  });

  it('selects a single day from the calendar, including a day inside a range', () => {
    const spanning = makeWork({ id: 's', occurredOn: range('2026-03-01', '2026-03-31') });
    const result = runQuery([...records, spanning], query({ onDay: '2026-03-20' }), ctx);
    expect(result.map((r) => r.id).sort()).toEqual(['b', 's']);
  });

  it('matches search case-insensitively and across fields', () => {
    const result = runQuery(records, query({ search: '  单位甲  ' }), ctx);
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('returns nothing rather than everything when a filter matches no record', () => {
    expect(runQuery(records, query({ unit: '不存在的单位' }), ctx)).toEqual([]);
  });
});

describe('status buckets', () => {
  const records = [
    makeWork({ id: 'todo', status: 'todo' }),
    makeWork({ id: 'doing', status: 'in-progress' }),
    makeWork({ id: 'done', status: 'completed' }),
    makeWork({ id: 'cancelled', status: 'cancelled' }),
    makeWork({ id: 'deferred', status: 'deferred' }),
    makeWork({ id: 'long', longTerm: true }),
    makeWork({ id: 'late', reportDeadline: plain('2026-09-01') }),
    makeWork({ id: 'ancient', reportDeadline: plain('2026-01-01') }),
  ];

  it('treats "open" as everything not completed or cancelled', () => {
    const ids = runQuery(records, query({ statusBucket: 'open' }), ctx).map((r) => r.id);
    expect(ids).toContain('todo');
    expect(ids).toContain('deferred');
    expect(ids).not.toContain('done');
    expect(ids).not.toContain('cancelled');
  });

  it('separates live overdue from stale backlog', () => {
    expect(runQuery(records, query({ statusBucket: 'overdue' }), ctx).map((r) => r.id)).toEqual([
      'late',
    ]);
    expect(
      runQuery(records, query({ statusBucket: 'stale-backlog' }), ctx).map((r) => r.id),
    ).toEqual(['ancient']);
  });

  it('matches each canonical status exactly', () => {
    expect(runQuery(records, query({ statusBucket: 'deferred' }), ctx).map((r) => r.id)).toEqual([
      'deferred',
    ]);
    expect(runQuery(records, query({ statusBucket: 'long-term' }), ctx).map((r) => r.id)).toEqual([
      'long',
    ]);
  });
});

describe('sorting', () => {
  const undatedRecord = makeWork({ id: 'undated', occurredOn: freeText('1月') });
  const records = [
    makeWork({ id: 'mid', occurredOn: plain('2026-05-05') }),
    makeWork({ id: 'old', occurredOn: plain('2026-01-01') }),
    undatedRecord,
    makeWork({ id: 'new', occurredOn: plain('2026-09-01') }),
  ];

  it('places undated records LAST in both directions', () => {
    // Not clumped at one end: an unparseable date is neither the newest nor the oldest item.
    expect(runQuery(records, query({ sort: 'date-desc' }), ctx).map((r) => r.id)).toEqual([
      'new',
      'mid',
      'old',
      'undated',
    ]);
    expect(runQuery(records, query({ sort: 'date-asc' }), ctx).map((r) => r.id)).toEqual([
      'old',
      'mid',
      'new',
      'undated',
    ]);
  });

  it('orders by urgency using the same weights the dashboard uses', () => {
    const urgent = [
      makeWork({ id: 'later', reportDeadline: plain('2026-10-30') }),
      makeWork({ id: 'overdue', reportDeadline: plain('2026-09-01') }),
      makeWork({ id: 'today', reportDeadline: plain('2026-09-21') }),
      makeWork({ id: 'soon', reportDeadline: plain('2026-09-24') }),
    ];
    expect(runQuery(urgent, query({ sort: 'urgency' }), ctx).map((r) => r.id)).toEqual([
      'overdue',
      'today',
      'soon',
      'later',
    ]);
  });

  it('orders by overdue depth', () => {
    const backlog = [
      makeWork({ id: 'a', reportDeadline: plain('2026-09-20') }),
      makeWork({ id: 'b', reportDeadline: plain('2026-06-01') }),
      makeWork({ id: 'c', reportDeadline: plain('2026-09-10') }),
    ];
    expect(runQuery(backlog, query({ sort: 'overdue-desc' }), ctx).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('option derivation', () => {
  const records = [
    makeWork({ counterpartUnit: '乙单位', occurredOn: plain('2025-04-01') }),
    makeWork({ counterpartUnit: '甲单位', occurredOn: plain('2026-04-01') }),
    makeWork({ counterpartUnit: '', occurredOn: freeText('1月') }),
    makeHonor({ issuingOrg: '丙单位', awardedOn: plain('2024-01-01') }),
  ];

  it('lists distinct units from both record kinds, ignoring blanks', () => {
    expect(distinctUnits(records)).toEqual(['丙单位', '甲单位', '乙单位']);
  });

  it('derives years ONLY from structured dates, newest first', () => {
    // The legacy ledger used `date.slice(0,4)` with no validation, so `1月` produced a "1月年"
    // option that matched nothing.
    expect(distinctYears(records)).toEqual(['2026', '2025', '2024']);
  });

  it('counts records whose date is free text so the UI can say so', () => {
    expect(countUndated(records)).toBe(1);
  });
});

describe('followUpList', () => {
  it('returns open work needing attention, most pressing first, honours excluded', () => {
    const records = [
      makeHonor({ id: 'h' }),
      makeWork({ id: 'soon', reportDeadline: plain('2026-09-23') }),
      makeWork({ id: 'overdue', reportDeadline: plain('2026-09-18') }),
      makeWork({ id: 'stale', reportDeadline: plain('2026-01-01') }),
      makeWork({ id: 'done', status: 'completed', reportDeadline: plain('2026-09-01') }),
      makeWork({ id: 'longNoDate', longTerm: true }),
      makeWork({
        id: 'deleted',
        reportDeadline: plain('2026-09-01'),
        deletedAt: '2026-09-02T00:00:00.000Z',
      }),
    ];
    expect(followUpList(records, ctx).map((r) => r.id)).toEqual(['overdue', 'soon', 'longNoDate']);
  });
});

describe('nextDay', () => {
  it('rolls over months, years and leap days', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('2026-02-28')).toBe('2026-03-01');
  });
});
