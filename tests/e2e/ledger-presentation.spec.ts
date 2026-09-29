import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { runQuery, EMPTY_QUERY } from '@/domain/query';
import { buildSyntheticArchive } from '../perf/synthetic-archive';
import { gotoApp, navigate } from './helpers';

/**
 * The ledger renders ONE presentation: the table on a wide screen, the card list on a narrow one.
 *
 * Until the Phase-5 closeout it rendered both for every row and let CSS hide one; at 5,000 records
 * that made switching to 台账 about 25% slower than before Phase 5 (docs/phase-5-evidence.md §3). A
 * timing test would only notice that as noise, so this is the structural guard: with a large
 * archive, the presentation that is not in use must not exist in the DOM — and therefore not in the
 * accessibility tree — at all.
 *
 * Counts are taken on real markup (rows, list items), never on the `data-ledger-presentation` hooks,
 * so a regression that rendered both under new class names would still fail here.
 */

const WORK_COUNT = 1000;

async function seed(page: Page, archive: ReturnType<typeof buildSyntheticArchive>): Promise<void> {
  // Straight into the stores the application created, then reloaded; the import pipeline is not
  // what is being tested.
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

const archive = buildSyntheticArchive({ workCount: WORK_COUNT });
// The ledger's own default query: every live record, work and honours.
const LIVE = runQuery(archive.records, { ...EMPTY_QUERY, sort: 'date-desc' }).length;

async function openLedger(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await gotoApp(page, 'dashboard');
  await seed(page, archive);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '概览' })).toBeVisible();
  await navigate(page, '台账');
  await expect(page.getByRole('heading', { level: 1, name: '台账' })).toBeVisible();
}

async function expectTableOnly(page: Page): Promise<void> {
  const main = page.locator('main');
  await expect(main.locator('tbody tr')).toHaveCount(LIVE);
  await expect(main.getByRole('table')).toHaveCount(1);
  await expect(main.locator('.print-area li')).toHaveCount(0);
}

async function expectCardsOnly(page: Page): Promise<void> {
  const main = page.locator('main');
  await expect(main.locator('.print-area > ul > li')).toHaveCount(LIVE);
  await expect(main.locator('table')).toHaveCount(0);
  await expect(main.locator('tr')).toHaveCount(0);
  await expect(main.getByRole('row')).toHaveCount(0);
}

test.describe('ledger renders one presentation', () => {
  test.beforeEach(() => {
    test.setTimeout(120_000);
    expect(LIVE).toBeGreaterThan(WORK_COUNT);
  });

  test('desktop: table rows exist and no card exists', async ({ page }) => {
    await openLedger(page, 1440, 900);
    await expectTableOnly(page);
  });

  test('phone: cards exist and no table row exists', async ({ page }) => {
    await openLedger(page, 390, 844);
    await expectCardsOnly(page);
  });

  test('the switch sits exactly at 60rem, the width where the application bar stacks', async ({
    page,
  }) => {
    await openLedger(page, 960, 900);
    await expectTableOnly(page);
    await page.setViewportSize({ width: 959, height: 900 });
    await expectCardsOnly(page);
  });

  test('a live resize swaps the presentation instead of adding the other one', async ({ page }) => {
    await openLedger(page, 1440, 900);
    await expectTableOnly(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectCardsOnly(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectTableOnly(page);
  });

  test('a real print event commits the table before the handler returns', async ({ page }) => {
    await openLedger(page, 390, 844);
    await expectCardsOnly(page);
    /*
     * A browser takes its print layout as soon as `beforeprint` returns, so the table has to be in
     * the DOM on the very next line — read in the same synchronous task, with no await between.
     */
    const counts = await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeprint'));
      const during = {
        rows: document.querySelectorAll('main tbody tr').length,
        cards: document.querySelectorAll('main .print-area li').length,
      };
      window.dispatchEvent(new Event('afterprint'));
      return during;
    });
    expect(counts).toEqual({ rows: LIVE, cards: 0 });
    await expectCardsOnly(page);
  });

  test('printing at phone width renders the table, and only the table', async ({ page }) => {
    await openLedger(page, 390, 844);
    await expectCardsOnly(page);
    await page.emulateMedia({ media: 'print' });
    await expectTableOnly(page);
    await page.emulateMedia({ media: 'screen' });
    await expectCardsOnly(page);
  });
});
