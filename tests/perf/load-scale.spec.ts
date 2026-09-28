import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMPTY_QUERY, runQuery } from '@/domain/query';
import { gotoApp } from '../e2e/helpers';
import { buildSyntheticArchive } from './synthetic-archive';

/**
 * Browser-level cost at archive scale: 5,000 work records (plus 500 honours and ~3,300 progress
 * notes) in the production build.
 *
 * Not a gate. It prints `PERF {json}` lines — times in milliseconds measured inside the page with
 * `performance.now()`, so Playwright's own polling is not counted — and the Phase-5 record compares
 * the numbers taken before and after the hierarchy work on the same machine and the same archive.
 * The assertions only establish that each measurement really exercised the archive.
 *
 * Run with `npm run perf:browser`. It needs the production build, like the E2E suite.
 */

const WORK_COUNT = 5000;
const RELOADS = 5;
const SEARCH = '报告';

async function seed(page: Page, archive: ReturnType<typeof buildSyntheticArchive>): Promise<void> {
  // Written straight into the stores the application created, in one transaction, then reloaded:
  // the import pipeline is not what is being measured here.
  await page.evaluate(
    async ({ records, progress }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('civic-work-desk');
        open.onerror = () => {
          reject(open.error ?? new Error('open failed'));
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['records', 'progressEntries'], 'readwrite');
          for (const record of records) tx.objectStore('records').put(record);
          for (const entry of progress) tx.objectStore('progressEntries').put(entry);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            reject(tx.error ?? new Error('write failed'));
          };
        };
      });
    },
    { records: archive.records, progress: archive.progressEntries },
  );
}

/** Milliseconds from navigation start until the snapshot has loaded and a level-1 heading exists. */
async function reloadToReady(page: Page): Promise<number> {
  await page.reload({ waitUntil: 'commit' });
  const handle = await page.waitForFunction(
    () =>
      document.querySelector('main h1') !== null &&
      !document.body.innerText.includes('正在读取本机数据…')
        ? performance.now()
        : null,
    undefined,
    { polling: 'raf', timeout: 60_000 },
  );
  const readyAt = await handle.jsonValue();
  if (readyAt === null) throw new Error('the page never became ready');
  return readyAt;
}

/** Milliseconds from an action until `ready(arg)` holds, both read in the page. */
async function timeClick(
  page: Page,
  click: () => Promise<void>,
  ready: (arg: string) => boolean,
  arg = '',
): Promise<number> {
  const start = await page.evaluate(() => performance.now());
  await click();
  const handle = await page.waitForFunction(ready, arg, { polling: 'raf', timeout: 60_000 });
  await handle.dispose();
  const end = await page.evaluate(() => performance.now());
  return end - start;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function report(name: string, samples: readonly number[], size: number): void {
  const rounded = samples.map((value) => Math.round(value));
  console.log(
    `PERF ${JSON.stringify({ name, medianMs: Math.round(median(samples)), samples: rounded, size })}`,
  );
}

test(`load, list, search, ledger and export with ${String(WORK_COUNT)} work records`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const archive = buildSyntheticArchive({ workCount: WORK_COUNT });
  const liveWork = runQuery(archive.records, { ...EMPTY_QUERY, kind: 'work' }).length;
  const searchHits = runQuery(archive.records, {
    ...EMPTY_QUERY,
    kind: 'work',
    search: SEARCH,
  }).length;

  await gotoApp(page, 'dashboard');
  await seed(page, archive);

  const loads: number[] = [];
  for (let i = 0; i < RELOADS; i += 1) loads.push(await reloadToReady(page));
  report('load:dashboard', loads, archive.records.length);

  const nav = page.getByRole('navigation', { name: '主导航' });
  const workTimes: number[] = [];
  const searchTimes: number[] = [];
  const ledgerTimes: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await nav.getByRole('link', { name: '概览', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '概览' })).toBeVisible();

    workTimes.push(
      await timeClick(
        page,
        () => nav.getByRole('link', { name: '工作', exact: true }).click(),
        () => document.querySelector('main article') !== null,
      ),
    );
    await expect(
      page.getByRole('status').filter({ hasText: `共 ${String(liveWork)} 条` }),
    ).toBeVisible();

    const search = page.getByRole('searchbox', { name: '搜索记录' });
    const expected = `共 ${String(searchHits)} 条`;
    searchTimes.push(
      await timeClick(
        page,
        () => search.fill(SEARCH),
        (text) =>
          Array.from(document.querySelectorAll('[role="status"]')).some((node) =>
            node.textContent.includes(text),
          ),
        expected,
      ),
    );
    await expect(page.getByRole('status').filter({ hasText: expected })).toBeVisible();
    await search.fill('');

    ledgerTimes.push(
      await timeClick(
        page,
        () => nav.getByRole('link', { name: '台账', exact: true }).click(),
        () => document.querySelectorAll('main tbody tr').length > 0,
      ),
    );
  }
  report('route:work', workTimes, liveWork);
  report('filter:search', searchTimes, searchHits);
  report('route:ledger', ledgerTimes, await page.locator('main tbody tr').count());

  const exportTimes: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const started = Date.now();
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: '导出 XLSX' }).click();
    await download;
    exportTimes.push(Date.now() - started);
  }
  report('export:xlsx', exportTimes, liveWork);
});
