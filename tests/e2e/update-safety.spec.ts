import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  PROTOCOL_IMPORT,
  PROTOCOL_VARIANTS,
  UPDATE_ORIGIN,
  entryScript,
  makeOlderGeneration,
  makeUpdateWaiting,
  openControlledTab,
  openProfile,
  readProbe,
  startUpdateServer,
  tagDocument,
  waitForAppReady,
  withProbe,
  workerState,
} from './update-harness';
import type { OlderGeneration, Profile, UpdateServer } from './update-harness';

/**
 * Update safety across open pages (Phase 5.1).
 *
 * Two layers, both proven here in real browser profiles:
 *
 * 1. The product's own 应用更新 activates a waiting worker only when that worker reports no OTHER
 *    application window (final correction). Otherwise nothing is activated and nothing reloads: an
 *    older page must not be left running next to a generation that may have migrated the database. A
 *    probe inside the new worker records every skip-waiting message and window query it receives, and
 *    the windows that exist at the instant it activates, so "nothing was sent" is observed, not inferred.
 * 2. Defence in depth: when a worker is activated by something else (an older generation's 应用更新,
 *    or the browser), no page is reloaded behind its user's back (first Phase-5.1 correction).
 *
 * Each test has its own persistent profile. The pages start on an older generation of the interface
 * (`makeOlderGeneration`) and the server then moves to the current build, so "the new generation runs"
 * is checked by the entry script the page actually loaded. Synthetic text only.
 */

test.describe.configure({ timeout: 180_000 });

const PROMPT = '有新版本可用';
const APPLY = '应用更新';
const RETRY = '重试';
const BLOCKED = '检测到其他政务工作记录台页面仍在打开';
const UNKNOWN = '暂时无法确认是否还有其他政务工作记录台页面正在使用';
const NOTICE = '新版本已在其他页面中启用';
const REFRESH = '刷新到新版本';
const UNSAVED = '版本切换保护测试：尚未保存的内容';
const NEW_ENTRY = `./${/assets\/index-[A-Za-z0-9_-]+\.js/.exec(readFileSync('dist/index.html', 'utf8'))?.[0] ?? 'missing'}`;

let server: UpdateServer;
let profile: Profile;
let older: OlderGeneration;

test.beforeEach(async ({ playwright, channel }) => {
  older = makeOlderGeneration();
  server = await startUpdateServer();
  server.setRoot(older.root);
  profile = await openProfile(playwright.chromium, channel);
});

test.afterEach(async () => {
  await profile.close();
  await server.close();
  older.cleanup();
});

/** Upgrade the program under the open pages; `page` finds the new worker, which then waits. */
async function upgrade(
  page: Page,
  transform: (script: string) => string = (script) => script,
): Promise<void> {
  server.setRoot('dist');
  server.setWorkerTransform((script) => withProbe(transform(script)));
  await makeUpdateWaiting(server, page, 1);
  await expect(page.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
}

async function openUnsavedForm(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(UNSAVED);
  return dialog;
}

async function openAt(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${UPDATE_ORIGIN}${path}`);
  return page;
}

async function expectReloaded(page: Page, stillLoaded: () => Promise<boolean>): Promise<void> {
  await expect.poll(() => stillLoaded().catch(() => false), { timeout: 30_000 }).toBe(false);
  await waitForAppReady(page);
}

async function expectStillWaiting(page: Page): Promise<void> {
  expect((await workerState(page)).waiting, 'the new worker is still waiting').toBe('installed');
}

async function expectNewGeneration(page: Page): Promise<void> {
  expect(await entryScript(page)).toBe(NEW_ENTRY);
  expect(await workerState(page)).toEqual({
    controlled: true,
    controlledByActive: true,
    active: 'activated',
    waiting: null,
    installing: null,
  });
}

/** Ask the waiting worker directly, as the product does, and describe what it reports. */
async function reportedWindows(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const waiting = registration?.waiting;
    if (!waiting) return ['no waiting worker'];
    const channel = new MessageChannel();
    const reply = new Promise<{ windows: { requester: boolean; kind: string }[] }>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent) => {
        resolve(event.data as { windows: { requester: boolean; kind: string }[] });
      };
    });
    waiting.postMessage({ type: 'CIVIC_WINDOW_CLIENTS', version: 1 }, [channel.port2]);
    const answer = await reply;
    return answer.windows
      .map((entry) => `${entry.requester ? 'requester:' : ''}${entry.kind}`)
      .sort();
  });
}

test('A. one application tab: the update activates, the tab reloads once, the new generation runs', async () => {
  const tab = await openControlledTab(profile.context, 'dashboard');
  expect(await entryScript(tab)).toBe(`./${older.entry}`);
  const tagged = await tagDocument(tab);
  await upgrade(tab);
  expect(await reportedWindows(tab)).toEqual(['requester:application']);

  await tab.getByRole('button', { name: APPLY }).click();
  await expectReloaded(tab, tagged.stillLoaded);
  await tab.waitForTimeout(1_000);
  expect(tagged.navigations(), 'reloaded exactly once').toBe(1);
  await expectNewGeneration(tab);

  const probe = await readProbe(tab);
  expect(probe.skipWaiting).toHaveLength(1);
  expect(probe.queries).toHaveLength(2); // the direct question above, then the product's own
  expect(probe.activatedWith).toEqual(['/#/dashboard']);
  // The residual race window: from the product's question arriving to its skip-waiting arriving.
  const gap = (probe.skipWaiting[0] ?? Number.NaN) - (probe.queries[1] ?? Number.NaN);
  await test.info().attach('question-to-activation-ms', { body: String(gap) });
  expect(gap).toBeGreaterThanOrEqual(0);
});

test('B. two application tabs: refused while the other is open, then activated after it closes', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const dialog = await openUnsavedForm(tabB);
  const taggedA = await tagDocument(tabA);
  const taggedB = await tagDocument(tabB);
  await upgrade(tabA);

  await tabA.getByRole('button', { name: APPLY }).click();
  await expect(tabA.getByText(BLOCKED)).toBeVisible();
  await expect(tabA.getByText('另有 1 个')).toBeVisible();
  await expect(tabA.getByRole('button', { name: RETRY })).toBeEnabled();
  await tabA.waitForTimeout(1_500);
  await expectStillWaiting(tabA);
  for (const tagged of [taggedA, taggedB]) {
    expect(await tagged.stillLoaded()).toBe(true);
    expect(tagged.navigations()).toBe(0);
  }
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '事项', exact: true })).toHaveValue(UNSAVED);
  let probe = await readProbe(tabA);
  expect(probe.skipWaiting, 'no skip-waiting message while refused').toHaveLength(0);
  expect(probe.queries).toHaveLength(1);
  expect(probe.activatedWith).toBeNull();

  // The other page's user saves and closes it; the retry asks the worker again.
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await tabB.close();
  await tabA.getByRole('button', { name: RETRY }).click();
  await expectReloaded(tabA, taggedA.stillLoaded);
  await expectNewGeneration(tabA);
  probe = await readProbe(tabA);
  expect(probe.queries).toHaveLength(2);
  expect(probe.skipWaiting).toHaveLength(1);
  expect(probe.activatedWith).toEqual(['/#/dashboard']);
  // The record saved in the closed tab is there in the new generation.
  await tabA
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '工作' })
    .click();
  await expect(tabA.getByText(UNSAVED).first()).toBeVisible();
});

test('C. three application tabs: refused until every other one is closed', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const tabC = await openControlledTab(profile.context, 'ledger');
  const taggedA = await tagDocument(tabA);
  await upgrade(tabA);

  await tabA.getByRole('button', { name: APPLY }).click();
  await expect(tabA.getByText('另有 2 个')).toBeVisible();
  await tabC.close();
  await tabA.getByRole('button', { name: RETRY }).click();
  await expect(tabA.getByText('另有 1 个')).toBeVisible();
  await expectStillWaiting(tabA);
  expect((await readProbe(tabA)).skipWaiting).toHaveLength(0);

  await tabB.close();
  await tabA.getByRole('button', { name: RETRY }).click();
  await expectReloaded(tabA, taggedA.stillLoaded);
  await expectNewGeneration(tabA);
  const probe = await readProbe(tabA);
  expect(probe.queries, 'one fresh question per attempt').toHaveLength(3);
  expect(probe.skipWaiting).toHaveLength(1);
  expect(probe.activatedWith).toEqual(['/#/dashboard']);
});

test('D. utility pages under /api/ do not block activation', async () => {
  const tab = await openControlledTab(profile.context, 'dashboard');
  const tagged = await tagDocument(tab);
  await openAt(profile.context, '/api/civic/start');
  await openAt(profile.context, '/api/civic/platform');
  await openAt(profile.context, '/api/civic/runtime');
  await upgrade(tab);
  expect(await reportedWindows(tab)).toEqual([
    'bootstrap',
    'platform',
    'requester:application',
    'service',
  ]);

  await tab.getByRole('button', { name: APPLY }).click();
  await expectReloaded(tab, tagged.stillLoaded);
  await expectNewGeneration(tab);
  expect((await readProbe(tab)).skipWaiting).toHaveLength(1);
});

test('D. the legacy /__civic/platform path gets the application shell from the worker, so it blocks', async () => {
  const tab = await openControlledTab(profile.context, 'dashboard');
  const legacy = await profile.context.newPage();
  const response = await legacy.goto(`${UPDATE_ORIGIN}/__civic/platform`);
  /*
   * The worker answers this navigation with the application shell. Its relative asset URLs resolve
   * under /__civic/, so here the interface does not start; the window is counted as an application
   * window all the same, which is the conservative reading the protocol commits to.
   */
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await legacy.title()).toBe('政务工作记录台');
  expect(await entryScript(legacy)).toBe(`./${older.entry}`);
  expect(
    await legacy.evaluate(
      () => document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src ?? '',
    ),
  ).toBe(`${UPDATE_ORIGIN}/__civic/${older.entry}`);
  await legacy.waitForTimeout(1_000);
  await expect(legacy.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  await upgrade(tab);
  expect(await reportedWindows(tab)).toEqual(['application', 'requester:application']);

  await tab.getByRole('button', { name: APPLY }).click();
  await expect(tab.getByText('另有 1 个')).toBeVisible();
  await expectStillWaiting(tab);
  expect((await readProbe(tab)).skipWaiting).toHaveLength(0);
});

const setProtocol =
  (body: string) =>
  (target: UpdateServer): void => {
    target.setFileOverride('/sw-client-awareness.js', body);
  };
const unchanged = (script: string): string => script;
const withoutProtocol = (script: string): string => {
  if (script.split(PROTOCOL_IMPORT).length !== 2) {
    throw new Error(`expected exactly one ${PROTOCOL_IMPORT} in the built worker`);
  }
  // `void 0`, not an empty string: the call is the first operand of a comma expression.
  return script.replace(PROTOCOL_IMPORT, 'void 0');
};

const UNKNOWN_CASES: readonly (readonly [
  string,
  (target: UpdateServer) => void,
  (script: string) => string,
])[] = [
  ['a worker without the protocol, which never answers', () => undefined, withoutProtocol],
  [
    'a worker that receives the question and never answers',
    setProtocol(PROTOCOL_VARIANTS.silent),
    unchanged,
  ],
  [
    'a "safe" answer arriving after the page stopped waiting',
    setProtocol(PROTOCOL_VARIANTS.late),
    unchanged,
  ],
  ['a malformed answer', setProtocol(PROTOCOL_VARIANTS.malformed), unchanged],
  ['an answer in a newer protocol version', setProtocol(PROTOCOL_VARIANTS.newerVersion), unchanged],
];

for (const [label, prepare, transform] of UNKNOWN_CASES) {
  test(`E. unknown, even with no other tab: ${label}`, async () => {
    const tab = await openControlledTab(profile.context, 'dashboard');
    const tagged = await tagDocument(tab);
    prepare(server);
    await upgrade(tab, transform);

    await tab.getByRole('button', { name: APPLY }).click();
    await expect(tab.getByText(UNKNOWN)).toBeVisible({ timeout: 10_000 });
    await expect(tab.getByRole('button', { name: RETRY })).toBeEnabled();
    // Past the late answer's arrival: it must not activate anything either.
    await tab.waitForTimeout(7_000);
    await expectStillWaiting(tab);
    expect(await tagged.stillLoaded()).toBe(true);
    const probe = await readProbe(tab);
    expect(probe.queries).toHaveLength(1);
    expect(probe.skipWaiting, 'no skip-waiting message on an unknown answer').toHaveLength(0);
    expect(probe.activatedWith).toBeNull();
  });
}

test('the next generation never takes over while an older application tab is open', async () => {
  /*
   * The reason for the guard. The probed worker stands for a next generation that migrates the
   * database when it activates (no real schema change is made): its `activate` handler records which
   * windows exist at that instant. Pressing 应用更新 from either tab, repeatedly, must never get there
   * while the other tab is open; when it finally does, the only window left is the one that asked.
   */
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const taggedA = await tagDocument(tabA);
  await upgrade(tabA);
  await expect(tabB.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });

  await tabA.getByRole('button', { name: APPLY }).click();
  await expect(tabA.getByText(BLOCKED)).toBeVisible();
  for (let round = 0; round < 2; round += 1) {
    await tabA.getByRole('button', { name: RETRY }).click();
    await expect(tabA.getByRole('button', { name: RETRY })).toBeEnabled();
  }
  await tabB.getByRole('button', { name: APPLY }).click();
  await expect(tabB.getByText(BLOCKED)).toBeVisible();
  await tabA.waitForTimeout(1_000);
  let probe = await readProbe(tabA);
  expect(probe.queries).toHaveLength(4);
  expect(probe.skipWaiting).toHaveLength(0);
  expect(probe.activatedWith, 'the next generation has not taken over').toBeNull();
  await expectStillWaiting(tabA);
  expect(await entryScript(tabB)).toBe(`./${older.entry}`);

  await tabB.close();
  await tabA.getByRole('button', { name: RETRY }).click();
  await expectReloaded(tabA, taggedA.stillLoaded);
  probe = await readProbe(tabA);
  expect(probe.activatedWith, 'windows open when the next generation took over').toEqual([
    '/#/dashboard',
  ]);
});

test('F. a tab opened while 应用更新 is pressed never runs the older generation unannounced', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  await upgrade(tabA);
  const late = await profile.context.newPage();
  await Promise.all([
    tabA.getByRole('button', { name: APPLY }).click(),
    late.goto(`${UPDATE_ORIGIN}/#/work`),
  ]);
  await waitForAppReady(late);
  await late.waitForTimeout(3_000);

  let outcome: string;
  if ((await workerState(late)).waiting === 'installed') {
    outcome = 'refused: the new tab was counted';
    await expect(tabA.getByText(BLOCKED)).toBeVisible();
  } else if ((await entryScript(late)) === NEW_ENTRY) {
    outcome = 'activated: the new tab opened on the new generation';
  } else {
    outcome = 'activated: the new tab opened on the older generation and was told';
    await expect(late.getByText(NOTICE)).toBeVisible();
  }
  await test.info().attach('race-outcome', { body: outcome });
});

test('an activation this product did not make still reloads no other tab', async () => {
  /*
   * Defence in depth. An older generation's 应用更新 (RC3 and earlier) sends the skip-waiting message
   * without asking; so does this test, from tab A. No tab may reload by itself: tab B keeps its unsaved
   * form, tab C in the background keeps its page, and each moves only when its user asks.
   */
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const tabC = await openControlledTab(profile.context, 'ledger');
  const dialog = await openUnsavedForm(tabB);
  const taggedA = await tagDocument(tabA);
  const taggedB = await tagDocument(tabB);
  const taggedC = await tagDocument(tabC);
  await upgrade(tabA);
  await tabA.bringToFront();

  await tabA.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  });
  for (const tab of [tabA, tabB, tabC]) {
    await expect(tab.getByText(NOTICE)).toBeVisible({ timeout: 30_000 });
  }
  await tabA.waitForTimeout(1_000);
  for (const tagged of [taggedA, taggedB, taggedC]) {
    expect(await tagged.stillLoaded()).toBe(true);
    expect(tagged.navigations()).toBe(0);
  }
  await expect(dialog.getByRole('textbox', { name: '事项', exact: true })).toHaveValue(UNSAVED);

  // An ordinary browser reload is an explicit request.
  await tabC.reload();
  await waitForAppReady(tabC);
  await expectNewGeneration(tabC);
  // Tab B saves first, then asks.
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await tabB.getByRole('button', { name: REFRESH }).click();
  await expectReloaded(tabB, taggedB.stillLoaded);
  await expectNewGeneration(tabB);
  await expect(tabB.getByText(UNSAVED).first()).toBeVisible();
  expect(await taggedA.stillLoaded()).toBe(true);
});

test('reloading a tab while an update waits does not start the new version', async () => {
  const tabA = await openControlledTab(profile.context, 'dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  const taggedA = await tagDocument(tabA);
  await upgrade(tabA);
  await expect(tabB.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });

  await tabB.reload();
  await waitForAppReady(tabB);
  await expectStillWaiting(tabB);
  expect(await entryScript(tabB)).toBe(`./${older.entry}`);
  await expect(tabB.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
  expect(await taggedA.stillLoaded()).toBe(true);
});
