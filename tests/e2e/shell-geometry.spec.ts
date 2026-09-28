import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { gotoApp, navigate } from './helpers';

/**
 * The application bar is a fixed coordinate frame on desktop.
 *
 * Until Phase 5 the bar's centred row read the per-route content width, so switching route moved the
 * brand and all six destinations: at 1920×1080, 180 px left on 台账 and 190 px right on 报告 (measured on
 * the Phase-4 build; docs/phase-5-product-evolution.md §1). The content keeps its per-route widths —
 * that part is deliberate and asserted here too, so the fix cannot be "make every page the same".
 *
 * Tolerance is 1 CSS px: sub-pixel rounding may differ between layouts, a jump may not.
 */

const ROUTES = ['概览', '工作', '荣誉', '台账', '报告', '设置'] as const;
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;

interface ShellGeometry {
  readonly brandLeft: number;
  readonly navLefts: readonly number[];
  readonly slotLeft: number;
  readonly slotRight: number;
  readonly mainWidth: number;
}

async function measure(page: Page): Promise<ShellGeometry> {
  const box = async (selector: string): Promise<{ x: number; width: number }> => {
    const found = await page.locator(selector).boundingBox();
    if (!found) throw new Error(`not laid out: ${selector}`);
    return found;
  };
  const brand = await box('[data-shell-part="brand"]');
  const slot = await box('[data-shell-part="action-slot"]');
  const main = await page.locator('main').evaluate((element) => {
    // The content column, not the full-width `main` box padding included.
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    );
  });
  const nav = page.getByRole('navigation', { name: '主导航' });
  const navLefts: number[] = [];
  for (const label of ROUTES) {
    const link = await nav.getByRole('link', { name: label, exact: true }).boundingBox();
    if (!link) throw new Error(`destination not laid out: ${label}`);
    navLefts.push(link.x);
  }
  return {
    brandLeft: brand.x,
    navLefts,
    slotLeft: slot.x,
    slotRight: slot.x + slot.width,
    mainWidth: main,
  };
}

for (const viewport of VIEWPORTS) {
  test(`${String(viewport.width)}×${String(viewport.height)}: brand, destinations and action slot stay put on all six routes`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await gotoApp(page, 'dashboard');

    const byRoute = new Map<string, ShellGeometry>();
    for (const label of ROUTES) {
      await navigate(page, label);
      byRoute.set(label, await measure(page));
    }

    const reference = byRoute.get('概览');
    if (!reference) throw new Error('no reference geometry');
    for (const [label, geometry] of byRoute) {
      expect(
        Math.abs(geometry.brandLeft - reference.brandLeft),
        `brand on ${label}`,
      ).toBeLessThanOrEqual(1);
      geometry.navLefts.forEach((left, index) => {
        expect(
          Math.abs(left - (reference.navLefts[index] ?? Number.NaN)),
          `destination ${ROUTES[index] ?? ''} on ${label}`,
        ).toBeLessThanOrEqual(1);
      });
      expect(
        Math.abs(geometry.slotLeft - reference.slotLeft),
        `slot left on ${label}`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.slotRight - reference.slotRight),
        `slot right on ${label}`,
      ).toBeLessThanOrEqual(1);
    }

    /*
     * Content widths still follow the view. At 1366 the standard and wide measures are both limited by
     * the viewport, so only the reading view differs; from 1920 all three do.
     */
    const width = (label: string): number => byRoute.get(label)?.mainWidth ?? Number.NaN;
    expect(width('报告')).toBeLessThan(width('概览'));
    if (viewport.width >= 1920) expect(width('台账')).toBeGreaterThan(width('概览'));
    else expect(Math.abs(width('台账') - width('概览'))).toBeLessThanOrEqual(1);
  });
}

test('the primary action sits inside the reserved slot, and an empty slot exposes nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await gotoApp(page, 'work');
  const slot = page.locator('[data-shell-part="action-slot"]');

  // A view with a primary action: the button is wholly inside the slot.
  const button = slot.getByRole('button', { name: '新增记录' });
  await expect(button).toBeVisible();
  const slotBox = await slot.boundingBox();
  const buttonBox = await button.boundingBox();
  if (!slotBox || !buttonBox) throw new Error('slot or button not laid out');
  expect(buttonBox.x).toBeGreaterThanOrEqual(slotBox.x - 0.5);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(slotBox.x + slotBox.width + 0.5);

  // A view without one: the slot still occupies its column, and holds nothing a user can reach.
  for (const label of ['台账', '报告', '设置']) {
    await navigate(page, label);
    await expect(slot).toBeAttached();
    expect((await slot.boundingBox())?.width ?? 0).toBeGreaterThan(0);
    await expect(slot.locator('button, a, input, select, textarea, [tabindex]')).toHaveCount(0);
    await expect(slot).toHaveText('');
    await expect(slot).not.toHaveAttribute('role');
  }
});

test('on a phone the bar stacks: brand and action on one line, destinations on the next', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoApp(page, 'work');
  const brand = await page.locator('[data-shell-part="brand"]').boundingBox();
  const action = await page.getByRole('button', { name: '新增记录' }).boundingBox();
  const nav = await page.getByRole('navigation', { name: '主导航' }).boundingBox();
  if (!brand || !action || !nav) throw new Error('bar not laid out');
  // Same line: their vertical extents overlap.
  expect(action.y).toBeLessThan(brand.y + brand.height);
  expect(brand.y).toBeLessThan(action.y + action.height);
  // Destinations below both.
  expect(nav.y).toBeGreaterThanOrEqual(
    Math.max(brand.y + brand.height, action.y + action.height) - 1,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
