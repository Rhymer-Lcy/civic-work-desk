import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createWorkRecord, gotoApp, navigate } from './helpers';

/**
 * Phase-2 product behaviour.
 *
 * These assert the *decisions* the redesign made, not its pixels. A screenshot comparison would fail
 * on every intended change and pass on a layout that had quietly stopped being usable; what is worth
 * pinning is narrower and more durable:
 *
 *   - the shell is one band and carries exactly one primary action, whose meaning follows the route;
 *   - an empty database is explained rather than shown as zeroes;
 *   - "no data" and "no matches" are different answers with different offers;
 *   - the work list is dense enough that a screen shows a working set, and its columns line up;
 *   - a filter that cannot return a result is not offered;
 *   - secondary filters can hide, but never while in force;
 *   - the ledger's columns are declared, so a two-character cell does not wrap on every row.
 */

/** Seven records is enough to measure density without making the test slow. */
async function seedRecords(page: Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await createWorkRecord(page, {
      title: `密度示范事项 ${String(index + 1).padStart(2, '0')}`,
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      unit: `示范单位 ${String(index + 1)}`,
    });
  }
}

test.describe('application shell', () => {
  test('one chrome band carries the six destinations and one primary action', async ({ page }) => {
    await gotoApp(page);

    const banner = page.getByRole('banner');
    const nav = banner.getByRole('navigation', { name: '主导航' });
    await expect(nav).toBeVisible();
    for (const label of ['概览', '工作', '荣誉', '台账', '报告', '设置']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }

    // The navigation lives inside the header band rather than in a second strip below it.
    const bannerBox = await banner.boundingBox();
    expect(bannerBox?.height ?? 0).toBeLessThanOrEqual(96);

    // Exactly one primary action, in the shell, not in the page.
    await expect(banner.getByRole('button', { name: '新增记录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新增记录' })).toHaveCount(1);
  });

  test('the primary action follows the route, and disappears where creation has no meaning', async ({
    page,
  }) => {
    await gotoApp(page);
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('button', { name: '新增记录' })).toBeVisible();

    await navigate(page, '荣誉');
    await expect(banner.getByRole('button', { name: '新增荣誉' })).toBeVisible();
    await expect(banner.getByRole('button', { name: '新增记录' })).toHaveCount(0);

    await navigate(page, '台账');
    await expect(banner.getByRole('button', { name: /^新增/ })).toHaveCount(0);

    await navigate(page, '报告');
    await expect(banner.getByRole('button', { name: /^新增/ })).toHaveCount(0);
  });

  test('the shell primary action opens the create dialog for the current view', async ({
    page,
  }) => {
    await gotoApp(page, 'honors');
    await page.getByRole('banner').getByRole('button', { name: '新增荣誉' }).click();
    await expect(page.getByRole('dialog', { name: '新增荣誉' })).toBeVisible();
  });
});

test.describe('first run', () => {
  test('an empty database is explained instead of shown as zeroes', async ({ page }) => {
    await gotoApp(page);

    await expect(page.getByRole('heading', { name: '开始建立你的工作记录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新增第一条记录' })).toBeVisible();
    // It says what the product is for, and where the data lives.
    await expect(page.getByText('数据只保存在本机浏览器')).toBeVisible();
    // And it explains the one thing users get wrong about backups.
    await expect(page.getByText(/只有 JSON 备份可以完整还原/)).toBeVisible();

    // None of the attention counts are rendered, because a zero is not an attention state.
    await expect(page.getByRole('button', { name: /^已逾期/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^今日到期/ })).toHaveCount(0);
  });

  test('attention counts appear once there is something to attend to', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '概览计数示范事项', date: '2026-09-15' });

    await navigate(page, '概览');
    await expect(page.getByRole('heading', { name: '开始建立你的工作记录' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /已逾期/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /今日到期/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /7 天内到期/ })).toBeVisible();
  });
});

test.describe('empty states distinguish their cause', () => {
  test('no data and no matches are different answers with different offers', async ({ page }) => {
    await gotoApp(page, 'work');

    // Nothing exists. The offer names the step and does not duplicate the shell's action.
    await expect(page.getByText('还没有工作记录')).toBeVisible();
    await expect(page.getByRole('button', { name: '新增第一条记录' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新增记录' })).toHaveCount(1);

    await createWorkRecord(page, { title: '筛选示范事项', date: '2026-09-15' });
    await page.getByRole('searchbox', { name: '搜索记录' }).fill('不存在的关键字');

    // Data exists; the filter excluded it. The count is stated and the offer is to clear the filter.
    await expect(page.getByText('没有符合当前筛选条件的记录')).toBeVisible();
    await expect(page.getByText(/本机共有 1 条工作记录/)).toBeVisible();
    await expect(page.getByText('还没有工作记录')).toHaveCount(0);

    await page.getByRole('button', { name: '清除全部筛选' }).first().click();
    await expect(page.getByRole('article', { name: '筛选示范事项' })).toBeVisible();
  });
});

test.describe('work list density and structure', () => {
  test('a desktop screen shows a working set, and the columns line up', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await gotoApp(page, 'work');
    await seedRecords(page, 7);

    const rows = page.getByRole('article');
    await expect(rows).toHaveCount(7);

    /*
     * Density, measured rather than described. The Phase-1 card was ~115 px tall, which put six
     * records on a 1080 px screen; a row is capped here at 56 px so a regression that re-inflates the
     * row fails the test rather than being noticed months later.
     */
    const box = await rows.first().boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(56);

    /*
     * Alignment is the other half of scanability: every row's status cell must start at the same x,
     * which is what lets the eye run down a column instead of reading each line.
     */
    const lefts = await rows.evaluateAll((articles) =>
      articles.map((article) => {
        const status = article.querySelector('button > span');
        return status ? Math.round(status.getBoundingClientRect().left) : -1;
      }),
    );
    expect(new Set(lefts).size).toBe(1);
  });

  test('the whole row is the disclosure control, and detail stays collapsed until asked for', async ({
    page,
  }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '展开示范事项',
      date: '2026-09-15',
      requirement: '示范完成要求',
    });

    const row = page.getByRole('article', { name: '展开示范事项' });
    /*
     * Located by position, not by name: the summary's accessible name ends in 展开详情 while collapsed
     * and 收起详情 once open, so a name-based locator stops matching the moment the thing it is
     * testing works.
     */
    const summary = row.getByRole('button').first();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(row.getByText('示范完成要求')).toBeHidden();

    // A wide target: the summary spans the row rather than being a 32 px chevron at the far edge.
    const rowBox = await row.boundingBox();
    const summaryBox = await summary.boundingBox();
    expect(summaryBox?.width ?? 0).toBeGreaterThan((rowBox?.width ?? 0) * 0.8);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(row.getByText('示范完成要求')).toBeVisible();
    // Detail is grouped rather than a flat list of eleven pairs.
    await expect(row.getByText('时间节点')).toBeVisible();
    await expect(row.getByText('对接信息')).toBeVisible();
  });
});

test.describe('filters', () => {
  test('secondary filters collapse, but never while one is in force', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '筛选折叠示范', date: '2026-09-15', unit: '单位甲' });

    // Collapsed by default: 年份 is not reachable until asked for.
    await expect(page.getByRole('combobox', { name: '年份', exact: true })).toBeHidden();

    await page.getByRole('button', { name: '更多筛选' }).click();
    const year = page.getByRole('combobox', { name: '年份', exact: true });
    await expect(year).toBeVisible();
    await year.selectOption('2026');

    /*
     * The important half: collapsing again must not hide an active filter. A filter in force but
     * invisible is how a user concludes the data is gone.
     */
    await page.getByRole('button', { name: '更多筛选' }).click();
    await expect(year).toBeVisible();
    await expect(page.getByRole('button', { name: /年份：2026年/ })).toBeVisible();
  });

  test('the honours view does not offer a filter that cannot return a result', async ({ page }) => {
    await gotoApp(page, 'honors');

    /*
     * 业务分类 only exists on work records, and the query layer rejects every non-work record when a
     * category is selected — so on 荣誉 the control could only ever empty the list (audit H-1).
     */
    await expect(page.getByRole('combobox', { name: '业务分类' })).toHaveCount(0);
    // The counterpart filter is kept, under the name honours actually use.
    await page.getByRole('button', { name: '更多筛选' }).click();
    await expect(page.getByRole('combobox', { name: '授予单位' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '对接单位' })).toHaveCount(0);
  });
});

test.describe('ledger', () => {
  test('columns are declared, so a short cell does not wrap on every row', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await gotoApp(page, 'work');
    await seedRecords(page, 4);
    await navigate(page, '台账');
    await expect(page.getByRole('heading', { name: '台账', level: 1 })).toBeVisible();

    /*
     * The Phase-1 defect was automatic table layout: 类别 was sized to fit "类别" and its two-character
     * value 工作 wrapped to two lines on every row, so row heights alternated and the table could not
     * be scanned. One line per 类别 cell is the property that broke.
     */
    const kindHeights = await page
      .getByRole('cell', { name: '工作', exact: true })
      .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().height)));
    expect(kindHeights.length).toBeGreaterThan(0);
    for (const height of kindHeights) expect(height).toBeLessThanOrEqual(40);
  });

  test('the ledger uses more of a wide viewport than the dashboard does', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '宽度示范事项', date: '2026-09-15' });

    /*
     * Wait for the destination's own heading before measuring it. `navigate()` only waits for the
     * loading state to clear, which can leave the measurement describing the view being left rather
     * than the view being entered — the same trap that made a responsive assertion pass vacuously.
     */
    const widthOf = async (heading: string): Promise<number> => {
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      const box = await page.getByRole('main').boundingBox();
      return box?.width ?? 0;
    };

    await navigate(page, '概览');
    const dashboard = await widthOf('概览');
    await navigate(page, '台账');
    const ledger = await widthOf('台账');
    await navigate(page, '报告');
    const reports = await widthOf('报告');

    // Data-dense wider than standard, and a reading view narrower than both.
    expect(ledger).toBeGreaterThan(dashboard);
    expect(dashboard).toBeGreaterThan(reports);
    // And the wide view genuinely uses the screen rather than floating in the middle of it.
    expect(ledger).toBeGreaterThanOrEqual(1920 * 0.9);
  });
});

test.describe('settings', () => {
  test('a section index reaches the destructive block without scrolling past everything', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page, 'settings');

    const index = page.getByRole('navigation', { name: '设置分区' });
    await expect(index).toBeVisible();
    await expect(index.getByRole('link', { name: '危险操作' })).toBeVisible();

    await index.getByRole('link', { name: '回收站' }).click();
    await expect(page.getByRole('heading', { name: /回收站/ })).toBeVisible();
  });
});
