import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { gotoApp, navigate } from './helpers';

/**
 * 回到顶部.
 *
 * Settings is the long page every build has, so it is the fixture: at 600 px of viewport height it
 * scrolls several screens. Each test first asserts that it really can scroll past the threshold, so a
 * layout change that shortened the page would fail loudly instead of making every "hidden" assertion
 * pass for the wrong reason.
 */

interface ScrollCall {
  readonly top?: number;
  readonly behavior?: string;
}

/** Record every `window.scrollTo` call, so the requested behaviour can be asserted, not inferred. */
async function recordScrollCalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    const original = window.scrollTo.bind(window);
    (window as unknown as { __scrollCalls: unknown[] }).__scrollCalls = calls;
    window.scrollTo = (...args: unknown[]) => {
      calls.push(args[0]);
      (original as (...a: unknown[]) => void)(...args);
    };
  });
}

async function scrollCalls(page: Page): Promise<ScrollCall[]> {
  return page.evaluate(() => (window as unknown as { __scrollCalls: ScrollCall[] }).__scrollCalls);
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    window.scrollTo({ top, behavior: 'instant' });
  }, y);
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function openLongPage(page: Page, size = { width: 1366, height: 600 }): Promise<void> {
  await page.setViewportSize(size);
  await gotoApp(page, 'settings');
  const room = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(room, 'settings must scroll well past the threshold').toBeGreaterThan(1500);
}

const control = (page: Page) => page.getByRole('button', { name: '回到顶部' });

test('hidden near the top, shown only after more than a viewport of scrolling', async ({
  page,
}) => {
  await openLongPage(page);
  // Hidden means absent from the accessibility tree, not merely transparent.
  await expect(control(page)).toHaveCount(0);

  await scrollTo(page, 300);
  await expect(control(page)).toHaveCount(0);

  await scrollTo(page, 1400);
  await expect(control(page)).toBeVisible();
  const box = await control(page).boundingBox();
  if (!box) throw new Error('control not laid out');
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  // Bottom-right, inside the viewport.
  expect(box.x + box.width).toBeLessThanOrEqual(1366);
  expect(box.x).toBeGreaterThan(1366 / 2);
  expect(box.y + box.height).toBeLessThanOrEqual(600);

  await scrollTo(page, 0);
  await expect(control(page)).toHaveCount(0);
});

test('activation scrolls smoothly back to the top and lands focus on <main>', async ({ page }) => {
  await recordScrollCalls(page);
  await openLongPage(page);
  await scrollTo(page, 1800);
  await control(page).click();

  await expect.poll(() => scrollY(page)).toBe(0);
  await expect(page.locator('main#main')).toBeFocused();
  const last = (await scrollCalls(page)).at(-1);
  expect(last).toEqual({ top: 0, behavior: 'smooth' });
  // The control hid itself once the top was reached; focus did not fall to <body> with it.
  await expect(control(page)).toHaveCount(0);
});

test('with reduced motion requested, the jump is instant', async ({ page }) => {
  await recordScrollCalls(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLongPage(page);
  await scrollTo(page, 1800);
  await control(page).click();

  // Read immediately: an instant scroll has already happened, a smooth one would still be under way.
  expect(await scrollY(page)).toBe(0);
  const last = (await scrollCalls(page)).at(-1);
  expect(last).toEqual({ top: 0, behavior: 'auto' });
  await expect(page.locator('main#main')).toBeFocused();
});

test('keyboard: it shows a focus ring and Enter activates it', async ({ page }) => {
  await openLongPage(page);
  await scrollTo(page, 1800);
  // A key press first, so the browser treats the following focus as keyboard focus.
  await page.keyboard.press('Shift');
  await control(page).focus();
  const outline = await control(page).evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe('none');

  await page.keyboard.press('Enter');
  await expect.poll(() => scrollY(page)).toBe(0);
  await expect(page.locator('main#main')).toBeFocused();
});

test('on a phone it sits inside the safe viewport and causes no horizontal overflow', async ({
  page,
}) => {
  await openLongPage(page, { width: 390, height: 844 });
  await scrollTo(page, 2000);
  await expect(control(page)).toBeVisible();
  const box = await control(page).boundingBox();
  if (!box) throw new Error('control not laid out');
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('it sits below toasts and dialogs in the stacking order', async ({ page }) => {
  await openLongPage(page);
  await scrollTo(page, 1800);
  const layers = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="回到顶部"]');
    const root = getComputedStyle(document.documentElement);
    return {
      button: Number(button ? getComputedStyle(button).zIndex : Number.NaN),
      toast: Number(root.getPropertyValue('--z-toast')),
      dialog: Number(root.getPropertyValue('--z-dialog')),
      header: Number(root.getPropertyValue('--z-header')),
    };
  });
  expect(layers.button).toBeLessThan(layers.header);
  expect(layers.button).toBeLessThan(layers.dialog);
  expect(layers.button).toBeLessThan(layers.toast);
});

test('a route change re-evaluates visibility', async ({ page }) => {
  await openLongPage(page);
  await scrollTo(page, 1800);
  await expect(control(page)).toBeVisible();

  // An empty 荣誉 page is shorter than the threshold, so the offset clamps and the control must go.
  await navigate(page, '荣誉');
  const room = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(room).toBeLessThan(600);
  await expect(control(page)).toHaveCount(0);
});
