import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  makeUpdateWaiting,
  openControlledTab,
  openProfile,
  startUpdateServer,
  tagDocument,
  waitForAppReady,
  workerState,
} from './update-harness';
import type { Profile, UpdateServer } from './update-harness';

/**
 * Accepting an update in one tab must not reload the others (Phase 5.1).
 *
 * Reproduced on the Phase-6 candidate, 2026-09-29: tab B held an open, unsaved 新增工作记录 form; tab A
 * pressed 应用更新; tab B reloaded without being asked and the typed text was gone. The records in
 * IndexedDB were safe; the unsaved input was not. The cause is vite-plugin-pwa 1.3.0's prompt-mode
 * registration: every tab that has shown the update prompt listens for workbox-window's `controlling`
 * event and, unless `onNeedReload` is supplied, calls `window.location.reload()` when the new worker
 * takes control, which `skipWaiting()` in any one tab does for all of them.
 *
 * Each test runs in its own persistent profile, because the tabs must share one service-worker
 * registration, and serves the build from `update-harness.ts` so a newer worker can be put in place
 * while the tabs stay open. Synthetic text only.
 */

test.describe.configure({ timeout: 120_000 });

const PROMPT = '有新版本可用';
const APPLY = '应用更新';
const NOTICE = '新版本已在其他页面中启用';
const RELOAD = '刷新到新版本';
const UNSAVED = '多标签页更新测试：尚未保存的内容';

let server: UpdateServer;
let profile: Profile;

test.beforeEach(async ({ playwright, channel }) => {
  server = await startUpdateServer();
  profile = await openProfile(playwright.chromium, channel);
});

test.afterEach(async () => {
  await profile.close();
  await server.close();
});

async function openUnsavedForm(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(UNSAVED);
  return dialog;
}

/** A tab that reloaded has lost its tag; wait for that, then for the application to be back. */
async function expectReloaded(page: Page, stillLoaded: () => Promise<boolean>): Promise<void> {
  await expect.poll(() => stillLoaded().catch(() => false), { timeout: 30_000 }).toBe(false);
  await waitForAppReady(page);
}

/** The page is controlled by the registration's only worker: nothing waits, nothing installs. */
async function expectOnNewWorker(page: Page): Promise<void> {
  expect(await workerState(page)).toEqual({
    controlled: true,
    controlledByActive: true,
    active: 'activated',
    waiting: null,
    installing: null,
  });
}

test('one tab: accepting the update reloads that tab onto the new worker', async () => {
  const tab = await openControlledTab(profile.context, 'dashboard');
  const document = await tagDocument(tab);
  await makeUpdateWaiting(server, tab, 1);
  await expect(tab.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });

  await tab.getByRole('button', { name: APPLY }).click();
  await expectReloaded(tab, document.stillLoaded);
  await expectOnNewWorker(tab);
  await expect(tab.getByText(PROMPT)).toHaveCount(0);
  await expect(tab.getByText(NOTICE)).toHaveCount(0);
});

test('two tabs: the other tab keeps its unsaved form and is told a new version is ready', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const dialog = await openUnsavedForm(tabB);
  const documentA = await tagDocument(tabA);
  const documentB = await tagDocument(tabB);

  await makeUpdateWaiting(server, tabA, 1);
  await expect(tabA.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
  await expect(tabB.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });

  await tabA.bringToFront();
  await tabA.getByRole('button', { name: APPLY }).click();

  // Tab A, where the update was accepted, moves to the new version.
  await expectReloaded(tabA, documentA.stillLoaded);
  await expectOnNewWorker(tabA);

  /*
   * Tab B is untouched: same document, dialog open, text in place. Checked before the notice, so the
   * uncorrected build fails on the reload itself. By now tab A has reloaded and started again, and
   * the controller change that triggered it reached every tab at the same moment.
   */
  await tabB.waitForTimeout(1_000);
  expect(await documentB.stillLoaded(), 'tab B still shows the document it had').toBe(true);
  expect(documentB.navigations(), 'tab B navigations').toBe(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '事项', exact: true })).toHaveValue(UNSAVED);

  // And it is told that a newer version is ready, with a way to reach it.
  await expect(tabB.getByText(NOTICE)).toBeVisible({ timeout: 30_000 });
  await expect(tabB.getByRole('button', { name: RELOAD })).toBeVisible();

  // Saving is the ordinary flow and does not move the page either.
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await documentB.stillLoaded()).toBe(true);

  // Only the user's own request moves tab B, and the saved record is there afterwards.
  await tabB.getByRole('button', { name: RELOAD }).click();
  await expectReloaded(tabB, documentB.stillLoaded);
  await expectOnNewWorker(tabB);
  await expect(tabB.getByText(NOTICE)).toHaveCount(0);
  await expect(tabB.getByText(UNSAVED).first()).toBeVisible();
});

test('three tabs, two in the background: only the accepting tab reloads', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const tabC = await openControlledTab(profile.context, 'ledger');
  const dialog = await openUnsavedForm(tabB);
  const documentA = await tagDocument(tabA);
  const documentB = await tagDocument(tabB);
  const documentC = await tagDocument(tabC);
  await tabA.bringToFront();
  const visibility = await Promise.all(
    [tabA, tabB, tabC].map((tab) => tab.evaluate(() => document.visibilityState)),
  );
  await test.info().attach('visibility', {
    body: JSON.stringify({ A: visibility[0], B: visibility[1], C: visibility[2] }),
  });

  await makeUpdateWaiting(server, tabA, 1);
  for (const tab of [tabA, tabB, tabC]) {
    await expect(tab.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
  }

  await tabA.getByRole('button', { name: APPLY }).click();
  await expectReloaded(tabA, documentA.stillLoaded);
  await expectOnNewWorker(tabA);

  await tabB.waitForTimeout(1_000);
  for (const [tab, tagged] of [
    [tabB, documentB],
    [tabC, documentC],
  ] as const) {
    expect(await tagged.stillLoaded()).toBe(true);
    expect(tagged.navigations()).toBe(0);
    await expect(tab.getByText(NOTICE)).toBeVisible({ timeout: 30_000 });
  }
  await expect(dialog.getByRole('textbox', { name: '事项', exact: true })).toHaveValue(UNSAVED);

  // An ordinary browser reload is also an explicit request, and lands on the new version.
  await tabC.reload();
  await waitForAppReady(tabC);
  await expectOnNewWorker(tabC);
  await expect(tabC.getByText(NOTICE)).toHaveCount(0);
  expect(await documentB.stillLoaded(), 'reloading tab C leaves tab B alone').toBe(true);
});

test('reloading a tab while an update waits does not start the new version', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const documentA = await tagDocument(tabA);

  await makeUpdateWaiting(server, tabA, 1);
  await expect(tabB.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });

  await tabB.reload();
  await waitForAppReady(tabB);
  // Still under the old worker, the update still waiting, and the choice still offered.
  const state = await workerState(tabB);
  expect(state.controlled).toBe(true);
  expect(state.waiting).toBe('installed');
  await expect(tabB.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
  expect(await documentA.stillLoaded()).toBe(true);
});
