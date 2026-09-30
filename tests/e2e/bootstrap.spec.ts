import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import {
  PROTOCOL_IMPORT,
  PROTOCOL_VARIANTS,
  UPDATE_ORIGIN,
  entryScript,
  makeOlderGeneration,
  openControlledTab,
  openProfile,
  readProbe,
  startUpdateServer,
  tagDocument,
  waitForAppReady,
  withProbe,
  workerState,
} from './update-harness';
import type { OlderGeneration, Profile, RuntimeReply, UpdateServer } from './update-harness';

/**
 * The Windows update bootstrap, /api/civic/start (Phase 6).
 *
 * The page civic-server serves before the application: it establishes that the interface generation the
 * browser will run at `/` is the one the installed release expects, and when it is not, it offers the
 * switch only when the waiting worker reports no other application window, only on the user's click,
 * and verifies the result before entering. The files under test are the ones civic-server embeds
 * (deploy/windows/src/internal/httpserve/bootstrap), served by update-harness.ts under the same paths and
 * policy header. The pages start on an older generation of this build; the real RC3 upgrade from the
 * published installer is scripts/windows/acceptance-bootstrap.mjs.
 *
 * Every test drives the page only through what a person can do (its two buttons) and waits on the
 * state it publishes (<body data-state>), never on a fixed delay.
 */

test.describe.configure({ timeout: 300_000 });

const BUILT = (
  JSON.parse(readFileSync('dist/app-generation.json', 'utf8')) as { appGeneration: string }
).appGeneration;
const NEW_ENTRY = `./${/assets\/index-[A-Za-z0-9_-]+\.js/.exec(readFileSync('dist/index.html', 'utf8'))?.[0] ?? 'missing'}`;
const UNSAVED = '升级检查页测试：尚未保存的内容';

const expects = (appGeneration: string, canonicalOrigin = UPDATE_ORIGIN): RuntimeReply => ({
  kind: 'json',
  body: { schema: 'civic-runtime/1', appGeneration, releaseId: 'test-release', canonicalOrigin },
});

let server: UpdateServer;
let profile: Profile;
let older: OlderGeneration;

test.beforeEach(async ({ playwright, channel }) => {
  older = makeOlderGeneration();
  server = await startUpdateServer();
  profile = await openProfile(playwright.chromium, channel);
});

test.afterEach(async () => {
  await profile.close();
  await server.close();
  older.cleanup();
});

/** The older program has been installed and used: its worker controls the origin. */
async function useOlderProgram(route = 'dashboard'): Promise<Page> {
  server.setRoot(older.root);
  server.setRuntime(expects(older.generation));
  return openControlledTab(profile.context, route);
}

/** The program is upgraded underneath the browser: the server now serves the current build. */
function upgradeProgram(transform: (script: string) => string = (script) => script): void {
  server.setRoot('dist');
  server.setWorkerTransform((script) => withProbe(transform(script)));
  server.setRuntime(expects(BUILT));
}

async function openStart(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${UPDATE_ORIGIN}/api/civic/start`);
  return page;
}

const stateOf = (page: Page): Promise<string | null> =>
  page
    .locator('body')
    .getAttribute('data-state', { timeout: 1_000 })
    .catch(() => null);

/** Wait until the bootstrap settles in one of `states` (the update check is bounded at 150 s). */
async function settlesIn(page: Page, states: readonly string[]): Promise<string> {
  await expect
    .poll(() => stateOf(page), { timeout: 200_000 })
    .toMatch(new RegExp(`^(${states.join('|')})$`));
  return (await stateOf(page)) ?? '';
}

/** The bootstrap handed over to the application, and the application runs the expected generation. */
async function expectEnteredCurrent(page: Page): Promise<void> {
  // The application root; the application itself then adds its hash route (#/dashboard).
  await expect
    .poll(
      () => {
        const url = new URL(page.url());
        return `${url.origin}${url.pathname}`;
      },
      { timeout: 60_000 },
    )
    .toBe(`${UPDATE_ORIGIN}/`);
  await waitForAppReady(page);
  expect(await entryScript(page)).toBe(NEW_ENTRY);
}

async function openUnsavedForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(UNSAVED);
}

test('first run: no worker yet, so the application opens at once', async () => {
  server.setRoot('dist');
  server.setRuntime(expects(BUILT));
  const start = await openStart(profile.context);
  await expectEnteredCurrent(start);
  await expect(start.getByText('进入新版本')).toHaveCount(0);
});

test('current: the worker already runs the expected generation, so nothing is asked', async () => {
  server.setRoot('dist');
  server.setRuntime(expects(BUILT));
  const app = await openControlledTab(profile.context, 'dashboard');
  await app.close();
  const start = await openStart(profile.context);
  await expectEnteredCurrent(start);
});

test('stale, no other window: offers the switch, switches on request, verifies, enters', async () => {
  const oldTab = await useOlderProgram();
  await oldTab.close();
  upgradeProgram();

  const start = await openStart(profile.context);
  expect(await settlesIn(start, ['ready', 'error-[a-z-]+', 'blocked', 'unknown'])).toBe('ready');
  expect((await readProbe(start)).skipWaiting, 'nothing activated before the click').toHaveLength(
    0,
  );

  await start.getByRole('button', { name: '进入新版本' }).click();
  await expectEnteredCurrent(start);
  expect(await workerState(start)).toMatchObject({ controlledByActive: true, waiting: null });
  const probe = await readProbe(start);
  expect(probe.skipWaiting).toHaveLength(1);
  expect(probe.queries.length, 'asked on the check and again on the click').toBeGreaterThanOrEqual(
    2,
  );
  expect(probe.activatedWith).toEqual(['/api/civic/start']);
});

test('stale with other application windows: refuses, keeps them and their input, switches once they close', async () => {
  const tabA = await useOlderProgram('dashboard');
  const tabB = await openControlledTab(profile.context, 'work');
  await openUnsavedForm(tabB);
  const taggedA = await tagDocument(tabA);
  const taggedB = await tagDocument(tabB);
  upgradeProgram();

  const start = await openStart(profile.context);
  expect(await settlesIn(start, ['blocked', 'ready', 'unknown', 'error-[a-z-]+'])).toBe('blocked');
  await expect(start.getByText('检测到其他政务工作记录台页面仍在打开')).toBeVisible();
  await expect(start.getByText('仍在打开的其他页面：2 个')).toBeVisible();
  await expect(start.getByRole('button', { name: '进入新版本' })).toBeHidden();
  expect((await workerState(start)).waiting).toBe('installed');
  for (const tagged of [taggedA, taggedB]) {
    expect(await tagged.stillLoaded()).toBe(true);
    expect(tagged.navigations()).toBe(0);
  }
  await expect(
    tabB
      .getByRole('dialog', { name: '新增工作记录' })
      .getByRole('textbox', { name: '事项', exact: true }),
  ).toHaveValue(UNSAVED);
  expect((await readProbe(start)).skipWaiting).toHaveLength(0);

  // One closed: still refused, and the count comes from a fresh question.
  await tabA.close();
  await start.getByRole('button', { name: '重试' }).click();
  expect(await settlesIn(start, ['blocked', 'ready', 'unknown', 'error-[a-z-]+'])).toBe('blocked');
  await expect(start.getByText('仍在打开的其他页面：1 个')).toBeVisible();

  // The other one saves its input and closes; now the switch is offered.
  const dialog = tabB.getByRole('dialog', { name: '新增工作记录' });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await tabB.close();
  await start.getByRole('button', { name: '重试' }).click();
  expect(await settlesIn(start, ['ready', 'blocked', 'unknown', 'error-[a-z-]+'])).toBe('ready');
  await start.getByRole('button', { name: '进入新版本' }).click();
  await expectEnteredCurrent(start);
  // The record saved in the older generation is there in the new one.
  await start
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '工作' })
    .click();
  await expect(start.getByText(UNSAVED).first()).toBeVisible();
});

test('utility pages under /api/ do not block the switch', async () => {
  const oldTab = await useOlderProgram();
  await oldTab.close();
  const platform = await profile.context.newPage();
  await platform.goto(`${UPDATE_ORIGIN}/api/civic/platform`);
  upgradeProgram();

  const start = await openStart(profile.context);
  expect(await settlesIn(start, ['ready', 'blocked', 'unknown', 'error-[a-z-]+'])).toBe('ready');
  await start.getByRole('button', { name: '进入新版本' }).click();
  await expectEnteredCurrent(start);
});

const withoutProtocol = (script: string): string => {
  if (script.split(PROTOCOL_IMPORT).length !== 2)
    throw new Error(`expected one ${PROTOCOL_IMPORT}`);
  return script.replace(PROTOCOL_IMPORT, 'void 0');
};
const UNKNOWN_CASES: readonly (readonly [string, string | null, (script: string) => string])[] = [
  ['a waiting worker without the protocol', null, withoutProtocol],
  ['a waiting worker that never answers', PROTOCOL_VARIANTS.silent, (s) => s],
  ['a "safe" answer that arrives too late', PROTOCOL_VARIANTS.late, (s) => s],
  ['a malformed answer', PROTOCOL_VARIANTS.malformed, (s) => s],
  ['an answer in a newer protocol version', PROTOCOL_VARIANTS.newerVersion, (s) => s],
];

for (const [label, protocol, transform] of UNKNOWN_CASES) {
  test(`unknown, even with no other window: ${label}`, async () => {
    const oldTab = await useOlderProgram();
    await oldTab.close();
    if (protocol !== null) server.setFileOverride('/sw-client-awareness.js', protocol);
    upgradeProgram(transform);

    const start = await openStart(profile.context);
    expect(await settlesIn(start, ['unknown', 'ready', 'blocked', 'error-[a-z-]+'])).toBe(
      'unknown',
    );
    await expect(
      start.getByText('暂时无法确认是否还有其他政务工作记录台页面正在打开'),
    ).toBeVisible();
    await expect(start.getByRole('button', { name: '进入新版本' })).toBeHidden();
    // Past a late answer's arrival, and after a retry: still nothing activated.
    await start.waitForTimeout(7_000);
    await start.getByRole('button', { name: '重试' }).click();
    expect(await settlesIn(start, ['unknown', 'ready', 'blocked', 'error-[a-z-]+'])).toBe(
      'unknown',
    );
    expect((await workerState(start)).waiting).toBe('installed');
    expect(start.url()).toBe(`${UPDATE_ORIGIN}/api/civic/start`);
    const probe = await readProbe(start);
    expect(probe.skipWaiting, 'no switch on an unknown answer').toHaveLength(0);
    expect(probe.activatedWith).toBeNull();
  });
}

interface ReplacementSnapshot {
  /** The type of every message each worker received, in order. */
  readonly messageTypes: {
    readonly A: readonly string[];
    readonly B: readonly string[];
    readonly active: readonly string[];
  };
  readonly waiting: 'A' | 'B' | null;
  readonly controllerIsActive: boolean;
  readonly controllerChanges: number;
  /** Registrations the browser itself holds: none, so nothing real can have been activated. */
  readonly realRegistrations: number;
}

/**
 * Installed before the check page's own script: the page's service-worker registration becomes a
 * scripted one whose waiting worker A, when asked, is first replaced by worker B and only then answers
 * with a valid "no other window" reply -- the order askFresh's identity check exists for. B answers the
 * same reply at once. Every message any worker receives is recorded; nothing else of the page changes.
 */
function scriptWaitingWorkerReplacement(): void {
  const received = {
    A: [] as string[],
    B: [] as string[],
    active: [] as string[],
  };
  let controllerChanges = 0;
  const safeAnswer = {
    type: 'CIVIC_WINDOW_CLIENTS_RESULT',
    version: 1,
    worker: 'installed',
    windows: [
      { requester: true, kind: 'bootstrap', route: null, visibility: 'visible', focused: true },
    ],
  };
  const typeOf = (message: unknown): string => {
    const type = (message as { type?: unknown } | null)?.type;
    return typeof type === 'string' ? type : typeof message;
  };
  const registration: {
    active: unknown;
    installing: null;
    waiting: unknown;
    update(): Promise<void>;
  } = { active: null, installing: null, waiting: null, update: () => Promise.resolve() };
  const makeWorker = (
    name: 'A' | 'B' | 'active',
    state: string,
    onQuestion: (port: MessagePort) => void,
  ): object => ({
    scriptURL: `${location.origin}/sw.js`,
    state,
    postMessage(message: unknown, transfer?: Transferable[]): void {
      received[name].push(typeOf(message));
      const port = transfer?.[0];
      if (typeOf(message) === 'CIVIC_WINDOW_CLIENTS' && port instanceof MessagePort) {
        onQuestion(port);
      }
    },
  });
  const active = makeWorker('active', 'activated', () => undefined);
  const workerB = makeWorker('B', 'installed', (port) => {
    setTimeout(() => {
      port.postMessage(safeAnswer);
    }, 0);
  });
  const workerA = makeWorker('A', 'installed', (port) => {
    setTimeout(() => {
      registration.waiting = workerB;
      port.postMessage(safeAnswer);
    }, 0);
  });
  registration.active = active;
  registration.waiting = workerA;
  Object.defineProperty(ServiceWorkerContainer.prototype, 'getRegistration', {
    configurable: true,
    value: () => Promise.resolve(registration),
  });
  Object.defineProperty(ServiceWorkerContainer.prototype, 'controller', {
    configurable: true,
    get: () => active,
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    controllerChanges += 1;
  });
  Object.defineProperty(window, '__civicReplacement', {
    value: {
      snapshot: async () => ({
        messageTypes: { A: [...received.A], B: [...received.B], active: [...received.active] },
        waiting:
          registration.waiting === workerA ? 'A' : registration.waiting === workerB ? 'B' : null,
        controllerIsActive: navigator.serviceWorker.controller === active,
        controllerChanges,
        realRegistrations: (await navigator.serviceWorker.getRegistrations()).length,
      }),
    },
  });
}

const replacementSnapshot = (page: Page): Promise<ReplacementSnapshot> =>
  page.evaluate(() =>
    (
      window as unknown as { __civicReplacement: { snapshot(): Promise<ReplacementSnapshot> } }
    ).__civicReplacement.snapshot(),
  );

/**
 * askFresh asks one waiting worker and accepts its answer only if that worker is still the one waiting.
 *
 * A real browser cannot be driven through this order deterministically: when a newer worker finishes
 * installing, the one it replaces becomes redundant and may be terminated before it answers, and silence
 * reads "unknown" whether or not the identity check exists, so a test built that way could not fail when
 * the check is removed. This test therefore scripts the registration and its workers
 * (scriptWaitingWorkerReplacement) and nothing else: the check page is the one civic-server embeds,
 * served with its policy header; the expected generation comes from the runtime endpoint and the served
 * one from /index.html, both over HTTP.
 */
test('unknown when the waiting worker is replaced while it answers; 重试 asks the new one', async () => {
  // Stale: the installed release expects this build, while `/` would still run the older one.
  server.setRoot(older.root);
  server.setRuntime(expects(BUILT));

  const start = await profile.context.newPage();
  const navigations: string[] = [];
  start.on('framenavigated', (frame) => {
    if (frame === start.mainFrame()) navigations.push(frame.url());
  });
  await start.addInitScript(scriptWaitingWorkerReplacement);
  await start.goto(`${UPDATE_ORIGIN}/api/civic/start`);

  // A answered "safe", but only after B had taken its place: the answer is not about the worker waiting.
  expect(await settlesIn(start, ['unknown', 'ready', 'blocked', 'error-[a-z-]+'])).toBe('unknown');
  expect(await start.locator('#facts').textContent()).toContain(
    'windows: unknown (waiting-worker-changed)',
  );
  await expect(start.getByText('暂时无法确认是否还有其他政务工作记录台页面正在打开')).toBeVisible();
  await expect(start.getByRole('button', { name: '进入新版本' })).toBeHidden();
  const retry = start.getByRole('button', { name: '重试' });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();

  const answered = await replacementSnapshot(start);
  expect(answered.waiting, 'B replaced A while A was answering').toBe('B');
  expect(answered.messageTypes.A, 'A was asked once').toEqual(['CIVIC_WINDOW_CLIENTS']);
  expect(answered.messageTypes.A, 'no SKIP_WAITING to A').not.toContain('SKIP_WAITING');
  expect(answered.messageTypes.B, 'nothing sent to B, SKIP_WAITING included').toEqual([]);
  expect(answered.messageTypes.active, 'nothing sent to the controlling worker').toEqual([]);
  expect(answered.controllerIsActive, 'the controller is unchanged').toBe(true);
  expect(answered.controllerChanges, 'no controller transition').toBe(0);
  expect(answered.realRegistrations).toBe(0);
  expect(new URL(start.url()).pathname).toBe('/api/civic/start');
  expect(
    navigations.map((url) => new URL(url).pathname),
    'never navigated to /',
  ).toEqual(['/api/civic/start']);

  // 重试 asks again, and asks the worker waiting NOW; the replaced one is not asked again.
  await retry.click();
  expect(await settlesIn(start, ['ready', 'unknown', 'blocked', 'error-[a-z-]+'])).toBe('ready');
  const retried = await replacementSnapshot(start);
  expect(retried.messageTypes.A, 'the replaced worker is not asked again').toEqual([
    'CIVIC_WINDOW_CLIENTS',
  ]);
  expect(retried.messageTypes.B, 'the retry asked the worker waiting now').toEqual([
    'CIVIC_WINDOW_CLIENTS',
  ]);
  expect(retried.messageTypes.B, 'no SKIP_WAITING to B').not.toContain('SKIP_WAITING');
  expect(retried.messageTypes.active).toEqual([]);
  expect(retried.controllerChanges).toBe(0);
  expect(navigations.map((url) => new URL(url).pathname)).toEqual(['/api/civic/start']);
});

test('the old interface with no newer worker to switch to: stops, and does not enter', async () => {
  const oldTab = await useOlderProgram();
  await oldTab.close();
  // The installed release says "new", but the server still serves the old files: nothing to install.
  server.setRuntime(expects(BUILT));
  const start = await openStart(profile.context);
  expect(await settlesIn(start, ['error-stale', 'ready', 'blocked', 'unknown', 'opening'])).toBe(
    'error-stale',
  );
  expect(start.url()).toBe(`${UPDATE_ORIGIN}/api/civic/start`);
});

for (const [label, reply] of [
  ['absent', { kind: 'absent' }],
  ['failing', { kind: 'failing' }],
  ['answering with a page', { kind: 'html' }],
  ['answering with another schema', { kind: 'json', body: { appGeneration: BUILT } }],
] as const satisfies readonly (readonly [string, RuntimeReply])[]) {
  test(`the installed generation cannot be read (runtime ${label}): stops, and does not enter`, async () => {
    server.setRoot('dist');
    server.setRuntime(reply);
    const start = await openStart(profile.context);
    expect(await settlesIn(start, ['error-runtime', 'opening', 'ready'])).toBe('error-runtime');
    await expect(start.getByRole('button', { name: '重试' })).toBeVisible();
    expect(start.url()).toBe(`${UPDATE_ORIGIN}/api/civic/start`);
  });
}

test('after the switch the browser still does not run the expected generation: stops', async () => {
  const oldTab = await useOlderProgram();
  await oldTab.close();
  upgradeProgram();
  server.setRuntime(expects('ui-NOTTHERE00'));
  const start = await openStart(profile.context);
  expect(await settlesIn(start, ['ready', 'blocked', 'unknown', 'error-[a-z-]+'])).toBe('ready');
  await start.getByRole('button', { name: '进入新版本' }).click();
  expect(await settlesIn(start, ['error-after-switch', 'opening'])).toBe('error-after-switch');
  expect(start.url()).toBe(`${UPDATE_ORIGIN}/api/civic/start`);
});

test('opened under another address than the fixed one: stops and names the fixed address', async () => {
  server.setRoot('dist');
  server.setRuntime(expects(BUILT, 'http://127.0.0.1:8765'));
  const start = await openStart(profile.context);
  expect(await settlesIn(start, ['error-origin', 'opening'])).toBe('error-origin');
  await expect(start.getByText('http://127.0.0.1:8765')).toBeVisible();
});
