import { describe, expect, it } from 'vitest';
import { defaultCategories, defaultGroups } from '@/domain/defaults';
import { validateRelationalIntegrity } from '@/domain/integrity';
import { EMPTY_QUERY, followUpList, runQuery } from '@/domain/query';
import type { RecordQuery } from '@/domain/query';
import { summarise } from '@/domain/reports';
import { buildSyntheticArchive } from './synthetic-archive';

/**
 * Domain-layer cost at archive scale.
 *
 * Not a gate: timings depend on the machine, so nothing here asserts a threshold. The file prints one
 * `PERF {json}` line per measurement and the Phase-5 record compares the same measurements taken
 * before and after the hierarchy work, on the same machine and the same synthetic archive. What the
 * assertions do check is that each measurement actually processed the archive — a query that silently
 * returned nothing would otherwise look very fast.
 *
 * Run with `npm run perf:domain`.
 */

const WORK_COUNT = 5000;
const TODAY = '2026-09-28';
const WARMUP = 3;
const RUNS = 15;

function measure(name: string, fn: () => number): number {
  let lastSize = 0;
  for (let i = 0; i < WARMUP; i += 1) lastSize = fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    lastSize = fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const p90 = samples[Math.floor(samples.length * 0.9)] ?? 0;
  console.log(
    `PERF ${JSON.stringify({ name, medianMs: Number(median.toFixed(2)), p90Ms: Number(p90.toFixed(2)), size: lastSize })}`,
  );
  return lastSize;
}

describe(`domain operations over ${String(WORK_COUNT)} work records`, () => {
  const archive = buildSyntheticArchive({ workCount: WORK_COUNT });
  const categories = defaultCategories();
  const groups = defaultGroups();
  const workQuery: RecordQuery = { ...EMPTY_QUERY, kind: 'work' };
  const context = { today: TODAY };

  it('measures the list, search, filters, follow-up, summary and integrity passes', () => {
    expect(archive.records.length).toBeGreaterThan(WORK_COUNT);

    expect(
      measure('query:work-list', () => runQuery(archive.records, workQuery, context).length),
    ).toBeGreaterThan(0);
    expect(
      measure(
        'query:search',
        () => runQuery(archive.records, { ...workQuery, search: '报告' }, context).length,
      ),
    ).toBeGreaterThan(0);
    expect(
      measure(
        'query:status-open',
        () => runQuery(archive.records, { ...workQuery, statusBucket: 'open' }, context).length,
      ),
    ).toBeGreaterThan(0);
    expect(
      measure(
        'query:sort-urgency',
        () => runQuery(archive.records, { ...workQuery, sort: 'urgency' }, context).length,
      ),
    ).toBeGreaterThan(0);
    expect(
      measure('follow-up', () => followUpList(archive.records, context).length),
    ).toBeGreaterThan(0);
    expect(
      measure('summarise', () => summarise(archive.records, categories, { today: TODAY }).total),
    ).toBeGreaterThan(0);
    // Zero issues is the expected result; the size reported is the record count scanned.
    measure('integrity', () => {
      const issues = validateRelationalIntegrity({
        records: archive.records,
        progressEntries: archive.progressEntries,
        categories,
        groups,
      });
      expect(issues).toEqual([]);
      return archive.records.length;
    });
  });
});
