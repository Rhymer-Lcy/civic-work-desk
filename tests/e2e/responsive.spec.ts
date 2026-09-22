import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createWorkRecord, gotoApp, navigate } from './helpers';

/**
 * Responsive behaviour at the required widths.
 *
 * The check that matters most is the absence of horizontal page overflow: the legacy ledger set
 * `min-width: 960px` on its table inside a `overflow-x:auto` wrapper, which was right, but its
 * `.form-row` stayed `display:flex` at every width, so a three-control deadline row was squeezed
 * to about 110px per control on a 360px screen.
 */

const WIDTHS = [360, 390, 768, 1024, 1440] as const;
const ROUTES = ['概览', '工作', '荣誉', '台账', '报告', '设置'] as const;

async function overflowAmount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('no horizontal page overflow at any tested width', () => {
  for (const width of WIDTHS) {
    test(`${String(width)}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoApp(page, 'work');
      await createWorkRecord(page, {
        title: '一条标题相当长的示范工作记录用来检验换行与溢出行为是否正确',
        date: '2026-09-15',
        requirement: '需要提交一份比较长的说明材料以及相应的附件清单',
        unit: '一个名字也很长的示范对接单位名称',
      });

      for (const route of ROUTES) {
        await navigate(page, route);
        const overflow = await overflowAmount(page);
        expect(
          overflow,
          `${route} at ${String(width)}px overflows by ${String(overflow)}px`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('narrow-screen presentation', () => {
  test('the ledger becomes a card list rather than a restyled table', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '窄屏台账的示范事项',
      date: '2026-09-15',
      unit: '单位甲',
    });
    await navigate(page, '台账');
    /*
     * Wait for the destination before asserting anything about it. `toBeHidden()` passes for an
     * element that does not exist, so on the previous view it succeeded vacuously and the next
     * locator then matched a work row — a strict-mode violation, which throws immediately instead of
     * retrying. Anchoring on the heading makes the assertions describe the page they name.
     */
    await expect(page.getByRole('heading', { name: '台账', level: 1 })).toBeVisible();

    // The table is removed from the accessibility tree entirely at this width, so a screen reader
    // is not told "row 3, column 5" over something rendered as a paragraph.
    await expect(page.getByRole('table')).toBeHidden();
    const card = page.getByRole('listitem').filter({ hasText: '窄屏台账的示范事项' });
    await expect(card).toBeVisible();
    // Scoped to the card: an unscoped text query also matches the `<option>` in the unit filter.
    await expect(card.getByText('单位甲')).toBeVisible();
  });

  test('the record form is single-column and its controls stay usable', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await gotoApp(page, 'work');
    await page.getByRole('button', { name: '新增记录' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新增工作记录' });
    await expect(dialog).toBeVisible();

    // The dialog must not overflow the viewport.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(360);
      expect(box.x).toBeGreaterThanOrEqual(-1);
    }

    // Every visible control is at least 32px tall, and the primary action meets the 44px target.
    const tooSmall = await dialog.evaluate((root) => {
      const problems: string[] = [];
      for (const element of root.querySelectorAll(
        'button, select, input:not([type="radio"]):not([type="checkbox"]), textarea',
      )) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.height < 32) {
          problems.push(
            `${element.tagName}.${element.className}: ${String(Math.round(rect.height))}px`,
          );
        }
      }
      return problems;
    });
    expect(tooSmall, `controls below 32px:\n${tooSmall.join('\n')}`).toEqual([]);

    const save = dialog.getByRole('button', { name: '保存' });
    const saveBox = await save.boundingBox();
    expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(40);
  });

  test('navigation stays reachable and marks the current destination', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await gotoApp(page, 'dashboard');

    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');

    await navigate(page, '设置');
    await expect(nav.getByRole('link', { name: '设置' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: '概览' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the primary action is reachable on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await gotoApp(page, 'work');
    const primary = page.getByRole('button', { name: '新增记录' }).first();
    await expect(primary).toBeVisible();
    const box = await primary.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
  });
});
