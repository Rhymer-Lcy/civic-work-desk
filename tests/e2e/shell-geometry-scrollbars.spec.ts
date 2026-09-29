import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { gotoApp, navigate } from './helpers';

/**
 * The fixed coordinate frame, measured in a browser that draws classic scrollbars.
 *
 * `shell-geometry.spec.ts` runs in Playwright's default headless Chromium, which is launched with
 * `--hide-scrollbars`: a route whose content overflows vertically reports a 0 px scrollbar there, so
 * the suite could not see what a scrollbar does to the bar. Ordinary Microsoft Edge on Windows draws a
 * 15 px classic scrollbar, and on routes that scroll it narrows the viewport the bar is laid out in
 * (Phase 6 packaged acceptance, 2026-09-29; docs/phase-5.1-runtime-update-safety.md §2). This file
 * therefore launches without `--hide-scrollbars`, and it refuses to pass unless the browser really
 * does reserve a scrollbar and the route set really does contain both a route that scrolls and one
 * that does not; otherwise the comparison below would be between identical layouts and prove nothing.
 *
 * It also carries its own negative control: with the root's `scrollbar-gutter` forced back to
 * `auto` it must measure a shift of several pixels, or the gate could not have caught the defect.
 *
 * Tolerance is 1 CSS px, as in `shell-geometry.spec.ts`.
 */

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const ROUTES = ['概览', '工作', '荣誉', '台账', '报告', '设置'] as const;
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2047, height: 1001 },
  { width: 2560, height: 1440 },
] as const;

/** The shift the negative control must reproduce. Half of any classic scrollbar in use today. */
const CONTROL_MIN_SHIFT = 5;

interface Frame {
  readonly brandLeft: number;
  readonly navLefts: readonly number[];
  readonly slotRight: number;
  /** The document scrolls vertically on this route at this viewport. */
  readonly scrolls: boolean;
}

async function frame(page: Page): Promise<Frame> {
  const box = async (selector: string): Promise<{ x: number; width: number }> => {
    const found = await page.locator(selector).boundingBox();
    if (!found) throw new Error(`not laid out: ${selector}`);
    return found;
  };
  const brand = await box('[data-shell-part="brand"]');
  const slot = await box('[data-shell-part="action-slot"]');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const navLefts: number[] = [];
  for (const label of ROUTES) {
    const link = await nav.getByRole('link', { name: label, exact: true }).boundingBox();
    if (!link) throw new Error(`destination not laid out: ${label}`);
    navLefts.push(link.x);
  }
  const scrolls = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollHeight > root.clientHeight;
  });
  return { brandLeft: brand.x, navLefts, slotRight: slot.x + slot.width, scrolls };
}

/** Largest route-to-route difference over the brand, every destination and the slot's right edge. */
function worstDelta(frames: ReadonlyMap<string, Frame>): { delta: number; where: string } {
  const all = [...frames.entries()];
  let delta = 0;
  let where = 'none';
  const consider = (label: string, pick: (f: Frame) => number): void => {
    const values = all.map(([, f]) => pick(f));
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > delta) {
      delta = spread;
      where = label;
    }
  };
  consider('brand left', (f) => f.brandLeft);
  ROUTES.forEach((route, index) => {
    consider(`${route} left`, (f) => f.navLefts[index] ?? Number.NaN);
  });
  consider('action-slot right', (f) => f.slotRight);
  return { delta, where };
}

/**
 * Width of a classic scrollbar in this browser: 0 where scrollbars are hidden or overlaid. Set up
 * through CSSOM property writes, which the shipped `style-src 'self'` policy does not govern.
 */
async function classicScrollbarWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.top = '-200px';
    probe.style.width = '100px';
    probe.style.height = '100px';
    probe.style.overflowY = 'scroll';
    document.body.append(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return width;
  });
}

async function report(testInfo: TestInfo, name: string, body: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(body, null, 2),
    contentType: 'application/json',
  });
}

for (const viewport of VIEWPORTS) {
  const size = `${String(viewport.width)}×${String(viewport.height)}`;
  test(`${size} with classic scrollbars: the bar does not move between routes`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await gotoApp(page, 'dashboard');

    // Precondition 1: this browser reserves space for a scrollbar at all.
    const scrollbar = await classicScrollbarWidth(page);
    expect(scrollbar, 'classic scrollbar width in this browser').toBeGreaterThan(0);

    const frames = new Map<string, Frame>();
    for (const label of ROUTES) {
      await navigate(page, label);
      frames.set(label, await frame(page));
    }

    // Precondition 2: both layouts are present, so the comparison is not between identical cases.
    const scrolling = ROUTES.filter((label) => frames.get(label)?.scrolls === true);
    const still = ROUTES.filter((label) => frames.get(label)?.scrolls === false);
    expect(scrolling.length, `routes that scroll at ${size}`).toBeGreaterThan(0);
    expect(still.length, `routes that do not scroll at ${size}`).toBeGreaterThan(0);

    const { delta, where } = worstDelta(frames);
    await report(testInfo, `geometry-${size}`, {
      viewport,
      scrollbar,
      scrolling,
      still,
      worst: { delta, where },
      frames: Object.fromEntries(frames),
    });
    // Reproduction marker, set only once both preconditions have held so that it cannot turn a
    // browser without scrollbars into a pass. The correction removes it.
    testInfo.fail(true, 'uncorrected shell: a classic scrollbar moves the bar between routes');
    expect(delta, `largest route-to-route shift at ${size} (${where})`).toBeLessThanOrEqual(1);

    /*
     * Negative control: put the root's gutter back to the browser default and measure one route that
     * scrolls against one that does not. An inline CSSOM write outranks the stylesheet, so this
     * reproduces the uncorrected layout without touching the build.
     */
    await page.evaluate(() => {
      document.documentElement.style.scrollbarGutter = 'auto';
    });
    const control = new Map<string, Frame>();
    for (const label of [scrolling[0], still[0]]) {
      if (label === undefined) continue;
      await navigate(page, label);
      control.set(label, await frame(page));
    }
    const shifted = worstDelta(control);
    await report(testInfo, `control-${size}`, { shifted, frames: Object.fromEntries(control) });
    expect(
      shifted.delta,
      `with scrollbar-gutter:auto the gate must see the shift at ${size} (${shifted.where})`,
    ).toBeGreaterThanOrEqual(CONTROL_MIN_SHIFT);
  });
}
