import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { confirmWithPhrase } from '../e2e/helpers';

/**
 * Deterministic review screenshots.
 *
 * Not a pixel test. Nothing here compares against a golden image, because a UX review needs to *see*
 * the interface, not be told that it is unchanged — and a golden-image gate on a phase whose purpose
 * is visual change would fail on every intended commit. These are evidence, regenerated on demand:
 *
 * ```bash
 * npm run screenshots
 * ```
 *
 * Three things make the output reproducible on any machine on any day:
 *
 *   - **the clock is pinned** to the fixture's `DEMO_NOW`, so overdue / due-today / upcoming states
 *     are fixed rather than depending on the day the capture runs;
 *   - **the data comes from a sealed v3 archive** (`tests/fixtures/demo-dataset.json`), imported
 *     through the application's own canonical-restore path, so it is the same 31 records every time;
 *   - **fonts are the system stack** and no animation is in flight, since captures wait for the
 *     network-idle state and an explicit settle.
 *
 * The dataset is entirely fictional — invented organisations and people, documentation-block phone
 * numbers. No screenshot here can contain real data, because the database it renders was built from
 * a file in the repository.
 */

const FIXTURE = 'tests/fixtures/demo-dataset.json';
const OUT_DIR = 'review/screenshots';

/**
 * The instant the browser clock is pinned to — **written in UTC on purpose**.
 *
 * `new Date('2026-09-22T12:00:00')` is parsed in the *runner's* zone (here UTC-4) and then observed
 * in the *browser's* zone, which this config fixes to Asia/Shanghai. Those differ by 12 hours, so
 * that spelling silently put the browser on 2026-09-23 and every deadline state shifted by a day:
 * the record designed to be "due today" rendered as "overdue by 1 day" and the 今日到期 count read 0.
 * Anchoring in UTC makes the browser's local date 2026-09-22 12:00 regardless of the runner.
 */
const DEMO_NOW = new Date('2026-09-22T04:00:00Z');

const VIEWPORTS = {
  '1366': { width: 1366, height: 768 },
  '1440': { width: 1440, height: 900 },
  '1920': { width: 1920, height: 1080 },
  '2560': { width: 2560, height: 1440 },
  '390': { width: 390, height: 844 },
} as const;

mkdirSync(OUT_DIR, { recursive: true });

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  /*
   * Scroll to the top and wait out any toast. Both matter for evidence rather than for tidiness: a
   * capture taken at an inherited scroll position shows the middle of a page and silently omits the
   * hierarchy above it, and a leftover success toast covers the lower third — the first capture of
   * the populated dashboard had both faults and would have supported the wrong conclusions.
   */
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.locator('[role="status"], [role="alert"]').filter({ hasText: '导入完成' }).waitFor({
    state: 'hidden',
    timeout: 8000,
  });
  // One frame plus a beat: enough for a dialog transition to finish, short enough to stay cheap.
  await page.waitForTimeout(250);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false });
}

async function open(page: Page, route: string): Promise<void> {
  await page.clock.setFixedTime(DEMO_NOW);
  await page.goto(`/#/${route}`);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await settle(page);
}

/**
 * Import the demo archive through the real restore path, then land on `route`.
 *
 * Deliberately the user's route rather than a `page.evaluate` that writes IndexedDB directly: the
 * restore path is signed-off code, it validates the archive on the way in, and using it means the
 * screenshots depict a state the application itself produced.
 */
async function loadDemoData(page: Page, route: string): Promise<void> {
  await open(page, 'settings');
  await page.getByRole('button', { name: '导入 / 还原备份' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
  await dialog.getByRole('radio', { name: /替换 \/ 还原/ }).check();
  await dialog.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(dialog.getByText('导入预览（尚未写入）')).toBeVisible();
  await dialog.getByRole('button', { name: '完整还原', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: '替换全部数据？' });
  await expect(confirm).toBeVisible();
  await confirmWithPhrase(confirm, '替换', '确认替换');
  await expect(dialog).toBeHidden();

  await page.goto(`/#/${route}`);
  await settle(page);
}

test.describe('review screenshots', () => {
  test('first-run empty states', async ({ page }) => {
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(viewport);
      await open(page, 'dashboard');
      await shoot(page, `dashboard-empty-${label}`);
    }
    await page.setViewportSize(VIEWPORTS['1366']);
    await open(page, 'work');
    await shoot(page, 'work-empty-1366');
  });

  test('populated surfaces', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS['1920']);
    await loadDemoData(page, 'dashboard');

    const shots: readonly (readonly [keyof typeof VIEWPORTS, string, string])[] = [
      ['1366', 'dashboard', 'dashboard-populated-1366'],
      ['1440', 'dashboard', 'dashboard-populated-1440'],
      ['1920', 'dashboard', 'dashboard-populated-1920'],
      ['2560', 'dashboard', 'dashboard-populated-2560'],
      ['1366', 'work', 'work-1366'],
      ['1920', 'work', 'work-1920'],
      ['1440', 'honors', 'honors-1440'],
      ['1920', 'ledger', 'ledger-1920'],
      ['2560', 'ledger', 'ledger-2560'],
      ['1440', 'reports', 'reports-1440'],
      ['1440', 'settings', 'settings-1440'],
      ['390', 'dashboard', 'dashboard-mobile-390'],
      ['390', 'work', 'work-mobile-390'],
      ['390', 'ledger', 'ledger-mobile-390'],
    ];

    for (const [size, route, name] of shots) {
      await page.setViewportSize(VIEWPORTS[size]);
      await page.goto(`/#/${route}`);
      await shoot(page, name);
    }
  });

  test('detail and form states', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS['1920']);
    await loadDemoData(page, 'work');

    // An expanded record: detail grid plus progress timeline.
    const first = page.getByRole('article').first();
    await first.getByRole('button', { name: '展开详情' }).click();
    await shoot(page, 'work-detail-1920');

    // The create form, at the width a form is actually used at.
    await page.setViewportSize(VIEWPORTS['1440']);
    await page.goto('/#/work');
    await settle(page);
    await page.getByRole('button', { name: '新增记录' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shoot(page, 'edit-form-1440');
  });

  test('filtered-empty state', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS['1366']);
    await loadDemoData(page, 'work');
    await page.getByRole('searchbox').fill('不存在的关键字');
    await shoot(page, 'work-filter-empty-1366');
  });
});
