import { describe, expect, it } from 'vitest';
import {
  DUE_SOON_DAYS,
  STALE_OVERDUE_DAYS,
  describeVerdictWithSource,
  evaluateDeadline,
  isStaleBacklog,
  needsFollowUp,
  overdueDays,
} from '@/domain/deadlines';
import { freeText, makeWork, plain, range } from '../fixtures/records';

const TODAY = '2026-09-21';

describe('evaluateDeadline', () => {
  it('reports no deadline when neither field carries one', () => {
    const verdict = evaluateDeadline(makeWork(), TODAY);
    expect(verdict.level).toBe('none');
    expect(verdict.source).toBeNull();
    expect(verdict.daysRemaining).toBeNull();
  });

  it('classifies a reporting deadline by distance from today', () => {
    const cases: readonly [string, string, number][] = [
      ['2026-09-20', 'overdue', -1],
      ['2026-09-21', 'due-today', 0],
      ['2026-09-22', 'due-soon', 1],
      ['2026-09-28', 'due-soon', DUE_SOON_DAYS],
      ['2026-09-29', 'scheduled', 8],
    ];
    for (const [day, level, remaining] of cases) {
      const verdict = evaluateDeadline(makeWork({ reportDeadline: plain(day) }), TODAY);
      expect(verdict.level, `for ${day}`).toBe(level);
      expect(verdict.daysRemaining).toBe(remaining);
      expect(verdict.source).toBe('report');
    }
  });

  it('picks the EARLIER of the two deadlines and names which one drove it', () => {
    // The legacy defect: `deadlineInfo()` considered both, but every count and badge outside it
    // re-tested only `w.deadline`, so a completion-driven urgency was invisible to them.
    const completionDrives = makeWork({
      reportDeadline: plain('2026-10-30'),
      completionDeadline: plain('2026-09-19'),
    });
    const verdict = evaluateDeadline(completionDrives, TODAY);
    expect(verdict.level).toBe('overdue');
    expect(verdict.source).toBe('completion');
    expect(overdueDays(verdict)).toBe(2);
    expect(describeVerdictWithSource(verdict)).toBe('完成时限已逾期 2 天');

    const reportDrives = makeWork({
      reportDeadline: plain('2026-09-19'),
      completionDeadline: plain('2026-10-30'),
    });
    const other = evaluateDeadline(reportDrives, TODAY);
    expect(other.source).toBe('report');
    expect(describeVerdictWithSource(other)).toBe('上报时限已逾期 2 天');
  });

  it('judges a range by its END, so a window is not late on its first day', () => {
    const record = makeWork({ reportDeadline: range('2026-09-01', '2026-09-30') });
    const verdict = evaluateDeadline(record, TODAY);
    expect(verdict.level).toBe('scheduled');
    expect(verdict.day).toBe('2026-09-30');
    expect(verdict.daysRemaining).toBe(9);
  });

  it('closes completed and cancelled records so they never report overdue', () => {
    // The legacy `deadlineInfo()` did not look at status at all, so a finished record kept
    // rendering "已逾期 N 天" in its card meta forever.
    for (const status of ['completed', 'cancelled'] as const) {
      const record = makeWork({ status, reportDeadline: plain('2026-01-01') });
      const verdict = evaluateDeadline(record, TODAY);
      expect(verdict.level, status).toBe('closed');
      expect(overdueDays(verdict)).toBe(0);
      expect(needsFollowUp(record, verdict)).toBe(false);
    }
  });

  it('keeps deferred work in scope: postponing does not remove a deadline', () => {
    const record = makeWork({ status: 'deferred', reportDeadline: plain('2026-09-19') });
    const verdict = evaluateDeadline(record, TODAY);
    expect(verdict.level).toBe('overdue');
    expect(needsFollowUp(record, verdict)).toBe(true);
  });

  it('does not let longTerm suppress a real date', () => {
    // Legacy `deadlineInfo()` returned {text:'长期推进', urgent:9} before looking at any date, so a
    // long-term item with a genuine deadline could never be shown as overdue.
    const record = makeWork({ longTerm: true, reportDeadline: plain('2026-09-01') });
    const verdict = evaluateDeadline(record, TODAY);
    expect(verdict.level).toBe('overdue');
    expect(overdueDays(verdict)).toBe(20);
  });

  it('reports a text-only deadline without inventing a date', () => {
    const record = makeWork({
      reportDeadline: freeText('待定（4月前）'),
      completionDeadline: freeText('本周内'),
    });
    const verdict = evaluateDeadline(record, TODAY);
    expect(verdict.level).toBe('text-only');
    expect(verdict.day).toBeNull();
    expect(verdict.textParts).toEqual(['待定（4月前）', '本周内']);
    expect(describeVerdictWithSource(verdict)).toBe('待定（4月前） / 本周内');
  });

  it('carries text deadlines alongside a structured one', () => {
    const record = makeWork({
      reportDeadline: plain('2026-09-25'),
      completionDeadline: freeText('月底前'),
    });
    const verdict = evaluateDeadline(record, TODAY);
    expect(verdict.level).toBe('due-soon');
    expect(verdict.source).toBe('report');
    expect(verdict.textParts).toEqual(['月底前']);
  });
});

describe('backlog separation', () => {
  it('splits historical backlog from live overdue at the 30-day line', () => {
    const justInside = makeWork({ reportDeadline: plain('2026-08-22') }); // 30 days
    const justOutside = makeWork({ reportDeadline: plain('2026-08-21') }); // 31 days
    expect(overdueDays(evaluateDeadline(justInside, TODAY))).toBe(STALE_OVERDUE_DAYS);
    expect(isStaleBacklog(evaluateDeadline(justInside, TODAY))).toBe(false);
    expect(isStaleBacklog(evaluateDeadline(justOutside, TODAY))).toBe(true);
  });

  it('keeps stale backlog out of the follow-up list but not out of the data', () => {
    const stale = makeWork({ reportDeadline: plain('2026-01-01') });
    const verdict = evaluateDeadline(stale, TODAY);
    expect(verdict.level).toBe('overdue');
    expect(needsFollowUp(stale, verdict)).toBe(false);
  });
});

describe('needsFollowUp', () => {
  it('includes overdue, due-today and due-soon work', () => {
    for (const day of ['2026-09-20', '2026-09-21', '2026-09-25']) {
      const record = makeWork({ reportDeadline: plain(day) });
      expect(needsFollowUp(record, evaluateDeadline(record, TODAY)), day).toBe(true);
    }
  });

  it('includes open long-term work that has no deadline at all', () => {
    // This is the case the legacy dashboard could not surface: both `renderToday()` and
    // `renderAlert()` began with `if (w.longterm) return false`.
    const record = makeWork({ longTerm: true });
    const verdict = evaluateDeadline(record, TODAY);
    expect(verdict.level).toBe('none');
    expect(needsFollowUp(record, verdict)).toBe(true);
  });

  it('excludes ordinary work with no deadline', () => {
    const record = makeWork({ longTerm: false });
    expect(needsFollowUp(record, evaluateDeadline(record, TODAY))).toBe(false);
  });

  it('excludes a completed long-term item', () => {
    const record = makeWork({ longTerm: true, status: 'completed' });
    expect(needsFollowUp(record, evaluateDeadline(record, TODAY))).toBe(false);
  });
});
