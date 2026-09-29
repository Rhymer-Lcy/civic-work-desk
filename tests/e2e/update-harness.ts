import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { BrowserContext, BrowserType, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Harness for service-worker update tests (Phase 5.1).
 *
 * `vite preview` cannot change what it serves while a test runs, and an update test needs exactly
 * that: the same origin first serving one worker and then a newer one, the way an installed program
 * is upgraded underneath an open browser. This server serves the built `dist/` on its own fixed port
 * and lets a test:
 *
 *   - replace `sw.js` with a byte-different revision, so the browser finds an update and installs it
 *     as a waiting worker next to the one in control;
 *   - rewrite the worker script in other ways (for example to model an older worker without a
 *     message protocol this phase adds);
 *   - answer the deployment endpoint `/api/civic/runtime` in each of the shapes the application must
 *     tolerate: absent (404), failing (503), dropped connection, HTML (a SPA fallback), or JSON.
 *
 * Every test also gets its own persistent browser profile, because the behaviour under test is shared
 * between several windows of one profile, which an isolated per-test context cannot model.
 *
 * The port is fixed and never replaced by another: a busy port fails the test, as it does for
 * `vite preview` in playwright.config.ts.
 */

export const UPDATE_PORT = 4181;
export const UPDATE_ORIGIN = `http://127.0.0.1:${String(UPDATE_PORT)}`;

const DIST = resolve('dist');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export type RuntimeReply =
  | { readonly kind: 'absent' }
  | { readonly kind: 'failing' }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'html' }
  | { readonly kind: 'json'; readonly body: unknown };

export interface UpdateServer {
  readonly origin: string;
  /** Serve `sw.js` with this revision appended as a comment; 0 serves the built file unchanged. */
  setWorkerRevision(revision: number): void;
  /** Rewrite the served worker script; applied after the revision marker. */
  setWorkerTransform(transform: (script: string) => string): void;
  setRuntime(reply: RuntimeReply): void;
  /** Number of requests `/api/civic/runtime` has received. */
  runtimeRequests(): number;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  response.end(body);
}

export async function startUpdateServer(): Promise<UpdateServer> {
  if (!existsSync(join(DIST, 'index.html')) || !existsSync(join(DIST, 'sw.js'))) {
    throw new Error(`no production build in ${DIST}; run \`npm run build\` first`);
  }
  let revision = 0;
  let transform: (script: string) => string = (script) => script;
  let runtime: RuntimeReply = { kind: 'absent' };
  let runtimeCount = 0;

  const serveRuntime = (request: IncomingMessage, response: ServerResponse): void => {
    runtimeCount += 1;
    switch (runtime.kind) {
      case 'absent':
        send(response, 404, 'text/plain; charset=utf-8', 'not found');
        return;
      case 'failing':
        send(response, 503, 'text/plain; charset=utf-8', 'unavailable');
        return;
      case 'dropped':
        request.socket.destroy();
        return;
      case 'html':
        send(response, 200, TYPES['.html'] ?? '', readFileSync(join(DIST, 'index.html')));
        return;
      case 'json':
        send(response, 200, 'application/json', JSON.stringify(runtime.body));
        return;
    }
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', UPDATE_ORIGIN);
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/civic/runtime') {
      serveRuntime(request, response);
      return;
    }
    if (path.startsWith('/api/')) {
      send(response, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    if (path === '/sw.js') {
      const built = readFileSync(join(DIST, 'sw.js'), 'utf8');
      const marked =
        revision > 0 ? `${built}\n// civic-test-worker-revision ${String(revision)}\n` : built;
      send(response, 200, TYPES['.js'] ?? '', transform(marked));
      return;
    }
    const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(DIST + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      send(response, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    send(response, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
  });
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(UPDATE_PORT, '127.0.0.1', () => {
      ready();
    });
  });

  return {
    origin: UPDATE_ORIGIN,
    setWorkerRevision(next) {
      revision = next;
    },
    setWorkerTransform(next) {
      transform = next;
    },
    setRuntime(next) {
      runtime = next;
    },
    runtimeRequests: () => runtimeCount,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

export interface Profile {
  readonly context: BrowserContext;
  close(): Promise<void>;
}

/** A fresh persistent profile in the project's browser (bundled Chromium, or installed Edge). */
export async function openProfile(
  chromium: BrowserType,
  channel: string | undefined,
): Promise<Profile> {
  const directory = mkdtempSync(join(tmpdir(), 'civic-update-'));
  const context = await chromium.launchPersistentContext(directory, {
    ...(channel ? { channel } : {}),
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  return {
    context,
    async close() {
      await context.close();
      // The browser may still hold files for a moment after closing; leftovers are temp files.
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 15_000 });
}

/** Open the application at `route` and return once this page is controlled by a service worker. */
export async function openControlledTab(context: BrowserContext, route: string): Promise<Page> {
  const page =
    context.pages().find((candidate) => candidate.url() === 'about:blank') ??
    (await context.newPage());
  await page.goto(`${UPDATE_ORIGIN}/#/${route}`);
  await waitForAppReady(page);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // The first page of a profile installs the worker but is not controlled by it (clientsClaim is
  // off on purpose); a reload puts it under the worker like every later page.
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    await page.reload();
    await waitForAppReady(page);
  }
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  return page;
}

export interface WorkerState {
  readonly controlled: boolean;
  /** The controller is the registration's active worker (not a replaced one). */
  readonly controlledByActive: boolean;
  readonly active: string | null;
  readonly waiting: string | null;
  readonly installing: string | null;
}

export async function workerState(page: Page): Promise<WorkerState> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const controller = navigator.serviceWorker.controller;
    return {
      controlled: controller !== null,
      controlledByActive: controller !== null && controller === (registration?.active ?? null),
      active: registration?.active?.state ?? null,
      waiting: registration?.waiting?.state ?? null,
      installing: registration?.installing?.state ?? null,
    };
  });
}

/**
 * Serve a newer worker and have `page` look for it, then wait until it is installed and waiting.
 * `registration.update()` stands in for the browser's own update check, whose timing it controls.
 *
 * Installed Edge holds this first `update()` of a fresh profile back until about 60 s after the
 * worker was first installed; bundled Chromium starts it at once (measured 2026-09-29: an `update()`
 * issued 30 s after installation started its script request at 29.7 s, and a second `update()` right
 * after that one resolved in 16 ms). The mechanism was not identified. It is why each Edge test in
 * these files takes about a minute; a worker installed long before the check is not affected.
 */
export async function makeUpdateWaiting(
  server: UpdateServer,
  page: Page,
  revision: number,
): Promise<void> {
  server.setWorkerRevision(revision);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
  await expect
    .poll(async () => (await workerState(page)).waiting, { timeout: 30_000 })
    .toBe('installed');
}

/**
 * Tag the document currently loaded in `page`. `stillLoaded()` is false once that document has been
 * replaced by a reload or navigation, and `navigations()` counts main-frame navigations since.
 */
export async function tagDocument(
  page: Page,
): Promise<{ stillLoaded: () => Promise<boolean>; navigations: () => number }> {
  const token = `civic-doc-${String(Date.now())}-${String(Math.random()).slice(2)}`;
  await page.evaluate((value) => {
    (window as unknown as { __civicDocumentTag?: string }).__civicDocumentTag = value;
  }, token);
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  return {
    stillLoaded: () =>
      page.evaluate(
        (value) =>
          (window as unknown as { __civicDocumentTag?: string }).__civicDocumentTag === value,
        token,
      ),
    navigations: () => navigations,
  };
}
