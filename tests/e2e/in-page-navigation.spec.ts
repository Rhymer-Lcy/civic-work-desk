import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { gotoApp, navigate } from './helpers';

/**
 * In-page links must not be read as routes.
 *
 * The application routes on the URL fragment (`#/dashboard`, `#/work`, …), and two in-page links used
 * the same namespace: the Settings section index (`#settings-*`) and the global skip link (`#main`).
 * Activating either one set `location.hash` to a fragment id, the router parsed it as an unknown route
 * and fell back to 概览 — 5 of 5 times, from every route (found 2026-09-29 while restoring the Phase-5
 * baseline). The Phase-2 test for the section index passed only when its assertion happened to run in
 * the moment before React re-rendered.
 *
 * Every assertion here is on the *settled* state: the route in the address bar, the level-1 heading
 * and the focused element, read after the activation has had every chance to navigate away.
 */

const SETTINGS_SECTIONS = [
  { id: 'settings-app', label: '应用信息' },
  { id: 'settings-data', label: '数据与备份' },
  { id: 'settings-trash', label: '回收站' },
  { id: 'settings-danger', label: '危险操作' },
] as const;

const ROUTE_HEADINGS = [
  { route: 'dashboard', heading: '概览' },
  { route: 'work', heading: '工作' },
  { route: 'honors', heading: '荣誉' },
  { route: 'ledger', heading: '台账' },
  { route: 'reports', heading: '报告' },
  { route: 'settings', heading: '设置' },
] as const;

/** Wait long enough for a hashchange-driven re-render to have happened if it is going to. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 150);
          });
        });
      }),
  );
}

async function activeElementId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

async function expectStillOn(page: Page, route: string, heading: string): Promise<void> {
  await settle(page);
  expect(await page.evaluate(() => window.location.hash)).toBe(`#/${route}`);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

test.describe('settings section index', () => {
  test.beforeEach(async ({ page }) => {
    // The index is shown from 80rem up; below that the single column is short enough to scroll.
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page, 'settings');
  });

  for (const section of SETTINGS_SECTIONS) {
    test(`pointer activation of ${section.label} stays on #/settings and focuses the section`, async ({
      page,
    }) => {
      const index = page.getByRole('navigation', { name: '设置分区' });
      await index.getByRole('link', { name: section.label, exact: true }).click();

      await expectStillOn(page, 'settings', '设置');
      expect(await activeElementId(page)).toBe(section.id);
      await expect(page.locator(`#${section.id}`)).toBeInViewport();
    });
  }

  test('keyboard activation stays on #/settings and focuses the section', async ({ page }) => {
    const link = page
      .getByRole('navigation', { name: '设置分区' })
      .getByRole('link', { name: '回收站', exact: true });
    await link.focus();
    await page.keyboard.press('Enter');

    await expectStillOn(page, 'settings', '设置');
    expect(await activeElementId(page)).toBe('settings-trash');
    await expect(page.locator('#settings-trash')).toBeInViewport();
    await expect(page.getByRole('heading', { name: /回收站/ })).toBeInViewport();
  });

  test('a section jump adds no history entry, so Back returns to the previous route', async ({
    page,
  }) => {
    await navigate(page, '工作');
    await navigate(page, '设置');
    await page
      .getByRole('navigation', { name: '设置分区' })
      .getByRole('link', { name: '危险操作', exact: true })
      .click();
    await expectStillOn(page, 'settings', '设置');

    await page.goBack();
    await expectStillOn(page, 'work', '工作');
    await page.goForward();
    await expectStillOn(page, 'settings', '设置');
  });
});

test.describe('skip link', () => {
  for (const { route, heading } of ROUTE_HEADINGS) {
    test(`on #/${route} it moves focus to <main> without leaving the route`, async ({ page }) => {
      await gotoApp(page, route);

      // The skip link is the first stop in the tab order.
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: '跳到主要内容' });
      await expect(skip).toBeFocused();
      await page.keyboard.press('Enter');

      await expectStillOn(page, route, heading);
      expect(await activeElementId(page)).toBe('main');
      await expect(page.locator('main#main')).toBeFocused();
    });
  }

  test('pointer activation behaves the same way', async ({ page }) => {
    await gotoApp(page, 'ledger');
    const skip = page.getByRole('link', { name: '跳到主要内容' });
    await skip.focus();
    await skip.click();

    await expectStillOn(page, 'ledger', '台账');
    await expect(page.locator('main#main')).toBeFocused();
  });
});

test.describe('route links are unchanged', () => {
  test('main navigation keeps real route hrefs for middle-click and copy-link', async ({
    page,
  }) => {
    await gotoApp(page);
    const nav = page.getByRole('navigation', { name: '主导航' });
    for (const { route, heading } of ROUTE_HEADINGS) {
      await expect(nav.getByRole('link', { name: heading, exact: true })).toHaveAttribute(
        'href',
        `#/${route}`,
      );
    }
  });

  test('a direct route link still opens that route', async ({ page }) => {
    await gotoApp(page, 'reports');
    await expectStillOn(page, 'reports', '报告');
  });

  test('sloppy and unknown route hashes still normalise exactly as before', async ({ page }) => {
    await gotoApp(page);
    const cases = [
      { hash: '#work', expected: '#/work', heading: '工作' },
      { hash: '#//ledger/', expected: '#/ledger', heading: '台账' },
      { hash: '#/nonsense', expected: '#/dashboard', heading: '概览' },
    ] as const;
    for (const { hash, expected, heading } of cases) {
      await page.goto(`/${hash}`);
      await page.reload();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await settle(page);
      expect(await page.evaluate(() => window.location.hash)).toBe(expected);
      await expect(
        page.getByRole('heading', { level: 1, name: heading, exact: true }),
      ).toBeVisible();
    }
  });
});
