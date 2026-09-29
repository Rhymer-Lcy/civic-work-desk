import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import {
  UPDATE_ORIGIN,
  makeUpdateWaiting,
  openProfile,
  startUpdateServer,
  waitForAppReady,
} from './update-harness';
import type { Profile, UpdateServer } from './update-harness';

/**
 * A WAITING worker can see every window of the origin (Phase 5.1).
 *
 * The question behind `public/sw-client-awareness.js`: before an update page activates a new worker,
 * can that worker, still waiting, tell it which other windows of the origin are open? Activation puts
 * every open page under the new worker at once, and pages of an older generation reload themselves when
 * that happens. The API exists (`clients.matchAll({ includeUncontrolled: true })`); whether a worker in
 * the `installed` state really sees windows that the OLD worker controls, windows no worker controls,
 * background windows, windows on other routes and windows opened before the upgrade is what this file
 * establishes, and it runs in bundled Chromium and in installed Edge.
 *
 * Playwright emulates focus on every page it drives, so here every page reports itself visible. Tabs
 * that are really hidden were checked separately in plain Edge driven over raw CDP, against the
 * published RC3 worker (docs/phase-5.1-runtime-update-safety.md, section 4).
 *
 * The old generation is modelled by serving the same build with the protocol's `importScripts` line
 * removed: a worker that never heard of the protocol, as RC3's did not. The requesting page stands at
 * `/api/civic/start`, where a future update page would, because `/api/` is the one path the navigation
 * fallback does not answer with the application shell.
 */

test.describe.configure({ timeout: 180_000 });

const IMPORT_LINE = 'importScripts("sw-client-awareness.js")';
const QUERY_REPEATS = 5;

interface WindowEntry {
  readonly requester: boolean;
  readonly kind: string;
  readonly route: string | null;
  readonly visibility: string;
  readonly focused: boolean;
}

type Answer =
  | { readonly outcome: 'answer'; readonly data: { worker: string; windows: WindowEntry[] } }
  | { readonly outcome: 'no-answer' }
  | { readonly outcome: 'no-worker' };

let server: UpdateServer;
let profile: Profile;

test.beforeEach(async ({ playwright, channel }) => {
  server = await startUpdateServer();
  server.setWorkerTransform((script) => {
    if (script.split(IMPORT_LINE).length !== 2) {
      throw new Error(`expected exactly one ${IMPORT_LINE} in the built worker`);
    }
    // `void 0`, not an empty string: the call is the first operand of a comma expression in the
    // generated worker, and deleting it leaves a syntax error that stops the old worker installing.
    return script.replace(IMPORT_LINE, 'void 0');
  });
  profile = await openProfile(playwright.chromium, channel);
});

test.afterEach(async () => {
  await profile.close();
  await server.close();
});

/** Ask the waiting (or active) worker over a MessageChannel; `no-answer` after `timeoutMs`. */
async function ask(page: Page, target: 'waiting' | 'active', timeoutMs = 5_000): Promise<Answer> {
  return page.evaluate(
    async ({ target: which, timeoutMs: limit }) => {
      const registration = await navigator.serviceWorker.getRegistration();
      const worker = which === 'waiting' ? registration?.waiting : registration?.active;
      if (!worker) return { outcome: 'no-worker' as const };
      const channel = new MessageChannel();
      const answer = new Promise<Answer>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ outcome: 'no-answer' });
        }, limit);
        channel.port1.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          resolve({
            outcome: 'answer',
            data: event.data as Extract<Answer, { outcome: 'answer' }>['data'],
          });
        };
      });
      worker.postMessage({ type: 'CIVIC_WINDOW_CLIENTS', version: 1 }, [channel.port2]);
      return answer;
    },
    { target, timeoutMs },
  );
}

async function openPage(context: BrowserContext, path: string): Promise<Page> {
  const page =
    context.pages().find((candidate) => candidate.url() === 'about:blank') ??
    (await context.newPage());
  await page.goto(`${UPDATE_ORIGIN}${path}`);
  return page;
}

const describeWindows = (windows: readonly WindowEntry[]): string[] =>
  windows
    .map((entry) => `${entry.requester ? 'requester:' : ''}${entry.kind}:${entry.route ?? '-'}`)
    .sort();

test('a waiting worker sees windows the old worker controls, uncontrolled, frozen and background ones', async () => {
  // First page of the profile: installs the old worker and, without a reload, stays uncontrolled.
  const dashboard = await openPage(profile.context, '/#/dashboard');
  await waitForAppReady(dashboard);
  await dashboard.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // Opened after the old worker is active, so controlled by it.
  const work = await openPage(profile.context, '/#/work');
  await waitForAppReady(work);
  const ledger = await openPage(profile.context, '/#/ledger');
  await waitForAppReady(ledger);
  const bootstrap = await openPage(profile.context, '/api/civic/start');

  const control = await Promise.all(
    [dashboard, work, ledger, bootstrap].map((page) =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    ),
  );
  expect(control, 'controlled: dashboard, work, ledger, bootstrap').toEqual([
    false,
    true,
    true,
    true,
  ]);

  /*
   * Freeze the ledger tab, the state Edge's sleeping tabs put a background tab in. A frozen page runs
   * no script, so it is not evaluated again until it is thawed at the end.
   */
  const lifecycle = await profile.context.newCDPSession(ledger);
  await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });

  // The upgrade: a newer worker, which carries the protocol, is installed and waits.
  server.setWorkerTransform((script) => script);
  await bootstrap.bringToFront();
  await makeUpdateWaiting(server, bootstrap, 1);

  // The old worker in control does not know the protocol: silence, which must never mean "none".
  expect(await ask(bootstrap, 'active', 2_000)).toEqual({ outcome: 'no-answer' });

  const expected = [
    'application:dashboard',
    'application:ledger',
    'application:work',
    'requester:bootstrap:-',
  ];
  const answers: Answer[] = [];
  for (let round = 0; round < QUERY_REPEATS; round += 1) {
    const answer = await ask(bootstrap, 'waiting');
    answers.push(answer);
    expect(answer.outcome, `round ${String(round)}`).toBe('answer');
    if (answer.outcome !== 'answer') continue;
    expect(answer.data.worker, 'answered by the waiting worker').toBe('installed');
    expect(describeWindows(answer.data.windows), `round ${String(round)}`).toEqual(expected);
  }
  await test
    .info()
    .attach('answers', { body: JSON.stringify(answers, null, 2), contentType: 'application/json' });

  // A window that closes leaves the count.
  await work.close();
  await expect
    .poll(async () => {
      const answer = await ask(bootstrap, 'waiting');
      return answer.outcome === 'answer' ? describeWindows(answer.data.windows) : [answer.outcome];
    })
    .toEqual(['application:dashboard', 'application:ledger', 'requester:bootstrap:-']);

  // Nothing was activated by asking: the old worker still controls, the new one still waits.
  const state = await bootstrap.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      waiting: registration?.waiting?.state ?? null,
      active: registration?.active?.state ?? null,
    };
  });
  expect(state).toEqual({ waiting: 'installed', active: 'activated' });

  await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
  expect(await ledger.evaluate(() => document.visibilityState)).toBeTruthy();
});

test('the answer carries only the classification: no URL, query or fragment text', async () => {
  const first = await openPage(profile.context, '/#/dashboard');
  await waitForAppReady(first);
  await first.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const marked = await openPage(profile.context, '/?probe=QUERY-MARKER#/reports?note=HASH-MARKER');
  await waitForAppReady(marked);
  const bootstrap = await openPage(profile.context, '/api/civic/start?token=START-MARKER');

  server.setWorkerTransform((script) => script);
  await makeUpdateWaiting(server, bootstrap, 1);
  const answer = await ask(bootstrap, 'waiting');
  expect(answer.outcome).toBe('answer');
  const text = JSON.stringify(answer);
  for (const marker of [
    'QUERY-MARKER',
    'HASH-MARKER',
    'START-MARKER',
    'probe',
    'note',
    'token',
    UPDATE_ORIGIN,
    'http',
  ]) {
    expect(text, `answer must not contain ${marker}`).not.toContain(marker);
  }
  if (answer.outcome !== 'answer') return;
  for (const entry of answer.data.windows) {
    expect(Object.keys(entry).sort()).toEqual([
      'focused',
      'kind',
      'requester',
      'route',
      'visibility',
    ]);
  }
  expect(describeWindows(answer.data.windows)).toEqual([
    'application:dashboard',
    'application:reports',
    'requester:bootstrap:-',
  ]);
});
