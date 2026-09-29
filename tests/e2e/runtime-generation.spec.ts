import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  makeOlderGeneration,
  openControlledTab,
  openProfile,
  startUpdateServer,
  tagDocument,
  waitForAppReady,
} from './update-harness';
import type { Profile, RuntimeReply, UpdateServer } from './update-harness';

/**
 * Runtime UI-generation mismatch (Phase 5.1).
 *
 * The page compares the generation of the interface it runs, taken from its own entry chunk, with the
 * generation the same-origin deployment endpoint `/api/civic/runtime` says the installed program
 * expects. The endpoint belongs to the deployment (Phase 6) and does not exist on today's servers, so
 * most of this file is about what must NOT happen: no notice while the endpoint is absent, failing,
 * unreachable, answering with a single-page fallback, or while the browser is offline. The positive
 * cases are the RC3 incident in miniature: an older interface kept alive by its service worker under a
 * server that has moved on, detected, and handed to the ordinary 应用更新 prompt, without the page being
 * reloaded, its caches cleared or its unsaved input lost.
 */

test.describe.configure({ timeout: 150_000 });

const BUILT = (
  JSON.parse(readFileSync('dist/app-generation.json', 'utf8')) as { appGeneration: string }
).appGeneration;
const NOTICE = '本机已安装新版本，本页面仍在运行旧版本';
const PROMPT = '有新版本可用';
const UNSAVED = '版本核对测试：尚未保存的内容';

const expects = (generation: string): RuntimeReply => ({
  kind: 'json',
  body: { schema: 'civic-runtime/1', appGeneration: generation },
});

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

/** The same event a user returning to the tab produces; the page checks again on it. */
async function returnToTab(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

async function entryScript(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') ?? null,
  );
}

/** Wait until the page has asked the endpoint at least `count` times in total. */
async function checked(count: number): Promise<void> {
  await expect
    .poll(() => server.runtimeRequests(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);
}

test('the running interface matches the build: no notice', async () => {
  server.setRuntime(expects(BUILT));
  const tab = await openControlledTab(profile.context, 'dashboard');
  await checked(1);
  await tab.waitForTimeout(500);
  await expect(tab.getByText(NOTICE)).toHaveCount(0);
  await expect(tab.getByText(PROMPT)).toHaveCount(0);
});

test('a different expected generation: a lasting notice, and nothing is reloaded or cleared', async () => {
  server.setRuntime(expects(BUILT));
  const tab = await openControlledTab(profile.context, 'work');
  await checked(1);

  await tab.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = tab.getByRole('dialog', { name: '新增工作记录' });
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(UNSAVED);
  const tagged = await tagDocument(tab);
  const before = await tab.evaluate(async () => ({
    caches: (await caches.keys()).sort(),
    databases: (await indexedDB.databases()).map((db) => db.name).sort(),
  }));

  const requests = server.runtimeRequests();
  server.setRuntime(expects('ui-NEWERGEN'));
  await returnToTab(tab);
  await checked(requests + 1);

  await expect(tab.getByText(NOTICE)).toBeVisible();
  await tab.waitForTimeout(2_000);
  await expect(tab.getByText(NOTICE), 'the notice stays').toBeVisible();
  expect(await tagged.stillLoaded(), 'the page was not reloaded').toBe(true);
  await expect(dialog.getByRole('textbox', { name: '事项', exact: true })).toHaveValue(UNSAVED);
  const after = await tab.evaluate(async () => ({
    caches: (await caches.keys()).sort(),
    databases: (await indexedDB.databases()).map((db) => db.name).sort(),
  }));
  expect(after, 'caches and databases untouched').toEqual(before);
  expect(before.caches.length).toBeGreaterThan(0);
});

for (const [label, reply] of [
  ['absent (404)', { kind: 'absent' }],
  ['failing (503)', { kind: 'failing' }],
  ['dropping the connection', { kind: 'dropped' }],
  ['answering with the application page', { kind: 'html' }],
  ['answering with another schema', { kind: 'json', body: { appGeneration: 'ui-NEWERGEN' } }],
] as const satisfies readonly (readonly [string, RuntimeReply])[]) {
  test(`endpoint ${label}: no notice, the application works`, async () => {
    server.setRuntime(reply);
    const tab = await openControlledTab(profile.context, 'dashboard');
    await checked(1);
    await returnToTab(tab);
    await checked(2);
    await tab.waitForTimeout(500);
    await expect(tab.getByText(NOTICE)).toHaveCount(0);
    await expect(tab.getByRole('navigation', { name: '主导航' })).toBeVisible();
  });
}

test('offline: no notice, and the application still opens from its service worker', async () => {
  server.setRuntime(expects(BUILT));
  const tab = await openControlledTab(profile.context, 'dashboard');
  await checked(1);
  // Were the check to reach the server now, it would report a mismatch.
  server.setRuntime(expects('ui-NEWERGEN'));
  const requests = server.runtimeRequests();

  await profile.context.setOffline(true);
  await tab.reload();
  await waitForAppReady(tab);
  await returnToTab(tab);
  await tab.waitForTimeout(1_000);
  await expect(tab.getByText(NOTICE)).toHaveCount(0);
  expect(server.runtimeRequests(), 'no request left the offline browser').toBe(requests);
  await profile.context.setOffline(false);
});

test('an older interface kept by its worker under a newer server is detected, then updated', async () => {
  const older = makeOlderGeneration();
  try {
    // The older program is installed and in use.
    server.setRoot(older.root);
    server.setRuntime(expects(older.generation));
    const tab = await openControlledTab(profile.context, 'dashboard');
    await checked(1);
    expect(await entryScript(tab)).toBe(`./${older.entry}`);
    await expect(tab.getByText(NOTICE)).toHaveCount(0);

    // The program is upgraded underneath the open browser.
    server.setRoot('dist');
    server.setRuntime(expects(BUILT));
    await tab.reload();
    await waitForAppReady(tab);
    // The worker of the older program still answers the navigation: the interface is stale.
    expect(await entryScript(tab), 'still the older interface after a reload').toBe(
      `./${older.entry}`,
    );

    // Detected, and the newer worker is looked for: its ordinary prompt takes over the notice.
    await expect(tab.getByText(PROMPT)).toBeVisible({ timeout: 90_000 });
    await tab.getByRole('button', { name: '应用更新' }).click();
    await expect
      .poll(() => entryScript(tab).catch(() => null), { timeout: 30_000 })
      .not.toBe(`./${older.entry}`);
    await waitForAppReady(tab);
    const requests = server.runtimeRequests();
    await returnToTab(tab);
    await checked(requests + 1);
    await tab.waitForTimeout(500);
    await expect(tab.getByText(NOTICE)).toHaveCount(0);
    await expect(tab.getByText(PROMPT)).toHaveCount(0);
  } finally {
    older.cleanup();
  }
});
