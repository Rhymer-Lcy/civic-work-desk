import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
 *     tolerate: absent (404), failing (503), dropped connection, HTML (a SPA fallback), or JSON;
 *   - switch the whole served tree to another build, such as the older generation made by
 *     `makeOlderGeneration`, to model a program upgrade under an open browser.
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

/*
 * The Windows update bootstrap (Phase 6), served exactly as civic-server serves it: the same two files
 * that deploy/windows/src/internal/httpserve embeds, under the same paths, with the same policy header
 * read out of bootstrap.go, so the page is tested under the restrictions it ships with.
 */
const BOOTSTRAP_DIR = resolve('deploy/windows/src/internal/httpserve/bootstrap');
const BOOTSTRAP_FILES = new Map([
  ['/api/civic/start', { file: 'start.html', type: 'text/html; charset=utf-8', policy: true }],
  [
    '/api/civic/start.js',
    { file: 'start.js', type: 'text/javascript; charset=utf-8', policy: false },
  ],
]);

function bootstrapPolicy(): string {
  const source = readFileSync(
    resolve('deploy/windows/src/internal/httpserve/bootstrap.go'),
    'utf8',
  );
  const declaration = /const bootstrapPolicy = ((?:"[^"]*"\s*\+?\s*)+)/.exec(source)?.[1];
  if (declaration === undefined) throw new Error('bootstrapPolicy not found in bootstrap.go');
  return [...declaration.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join('');
}

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
  /** Serve this build directory instead of `dist/` (worker script included). */
  setRoot(directory: string): void;
  /** Serve `body` for exactly this path instead of the file, or stop doing so with `null`. */
  setFileOverride(path: string, body: string | null): void;
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
  let root = DIST;
  let revision = 0;
  let transform: (script: string) => string = (script) => script;
  let runtime: RuntimeReply = { kind: 'absent' };
  let runtimeCount = 0;
  const overrides = new Map<string, string>();

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
        send(response, 200, TYPES['.html'] ?? '', readFileSync(join(root, 'index.html')));
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
    const bootstrap = BOOTSTRAP_FILES.get(path);
    if (bootstrap !== undefined) {
      response.writeHead(200, {
        'Content-Type': bootstrap.type,
        'Cache-Control': 'no-store',
        ...(bootstrap.policy ? { 'Content-Security-Policy': bootstrapPolicy() } : {}),
      });
      response.end(readFileSync(join(BOOTSTRAP_DIR, bootstrap.file)));
      return;
    }
    if (path.startsWith('/api/')) {
      send(response, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    const override = overrides.get(path);
    if (override !== undefined) {
      send(response, 200, TYPES[extname(path)] ?? 'application/octet-stream', override);
      return;
    }
    if (path === '/sw.js') {
      const built = readFileSync(join(root, 'sw.js'), 'utf8');
      const marked =
        revision > 0 ? `${built}\n// civic-test-worker-revision ${String(revision)}\n` : built;
      send(response, 200, TYPES['.js'] ?? '', transform(marked));
      return;
    }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
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
    setRoot(directory) {
      root = resolve(directory);
    },
    setFileOverride(path, body) {
      if (body === null) overrides.delete(path);
      else overrides.set(path, body);
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
 * Timing seen in installed Edge, 2026-09-29, recorded because it decides how long the Edge project
 * takes rather than whether it passes. When the profile's first page had just been installed and
 * reloaded (as `openControlledTab` does), Edge held the first `update()` back until about 60 s after
 * that point: issued at 30 s, its script request left at 59.7 s, and a second `update()` straight
 * after resolved in 16 ms. Bundled Chromium started the same call at once, and so did Edge in
 * client-awareness.spec.ts, whose pages are never reloaded. Whether installation or the reload is
 * the anchor, and the mechanism, were not established; update-safety.spec.ts therefore takes about
 * a minute per test in Edge.
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

export interface OlderGeneration {
  /** A copy of `dist/` whose interface is a different, older generation. */
  readonly root: string;
  readonly generation: string;
  /** The entry chunk's file name in that copy, e.g. `assets/index-OLDGEN00.js`. */
  readonly entry: string;
  cleanup(): void;
}

/**
 * A second, genuinely different generation of the built application, for stale-worker tests.
 *
 * Building the application twice inside a test run would be slow; renaming is enough, because the
 * generation is the entry chunk's name. The copy renames `assets/index-<hash>.js` to
 * `assets/index-OLDGEN00.js` and rewrites every file that names it: `index.html`, the worker's precache
 * list, `app-generation.json` and the lazily loaded chunks that import from the entry. It also gives
 * `index.html` a different precache revision, because the two generations would otherwise share the
 * revision and the newer worker would keep the older copy of `index.html`. Each declared rewrite must
 * match, or this throws instead of producing a copy that only looks different.
 */
export function makeOlderGeneration(): OlderGeneration {
  const root = mkdtempSync(join(tmpdir(), 'civic-older-generation-'));
  cpSync(DIST, root, { recursive: true });
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const hash = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html)?.[1];
  if (hash === undefined) throw new Error('no entry chunk named in dist/index.html');
  const from = `index-${hash}.js`;
  const to = 'index-OLDGEN00.js';
  renameSync(join(root, 'assets', from), join(root, 'assets', to));

  const rewritten: string[] = [];
  const textFiles = [
    ...readdirSync(root).map((name) => join(root, name)),
    ...readdirSync(join(root, 'assets')).map((name) => join(root, 'assets', name)),
  ].filter((file) => ['.html', '.js', '.json'].includes(extname(file)));
  for (const file of textFiles) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(from) && !text.includes(`ui-${hash}`)) continue;
    writeFileSync(file, text.replaceAll(from, to).replaceAll(`ui-${hash}`, 'ui-OLDGEN00'), 'utf8');
    rewritten.push(file.slice(root.length + 1).replaceAll('\\', '/'));
  }
  for (const required of ['index.html', 'sw.js', 'app-generation.json']) {
    if (!rewritten.includes(required))
      throw new Error(`older generation: ${required} not rewritten`);
  }

  const workerPath = join(root, 'sw.js');
  const worker = readFileSync(workerPath, 'utf8');
  const revision = /\{url:"index\.html",revision:"[0-9a-f]+"\}/g;
  const found = worker.match(revision) ?? [];
  if (found.length !== 1)
    throw new Error(`older generation: ${String(found.length)} index.html revisions`);
  writeFileSync(
    workerPath,
    worker.replace(revision, '{url:"index.html",revision:"0000000000000000000000000000older"}'),
    'utf8',
  );

  return {
    root,
    generation: 'ui-OLDGEN00',
    entry: `assets/${to}`,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/*
 * ---------------------------------------------------------------------------------------------------
 * Worker probe (Phase 5.1, activation guard)
 *
 * Prepended to a NEW worker's script, the probe records inside that worker, in a cache of its own:
 * every skip-waiting message it receives, every window-awareness query it receives (each with the time
 * it arrived), and, at the moment it activates, the windows of the origin that exist then. So "no
 * skip-waiting message was sent" and "no older application window was open when the next generation
 * took over" are observations made in the worker, not inferences from the page. It runs before the
 * generated worker's own listeners and changes nothing they do.
 * ---------------------------------------------------------------------------------------------------
 */
const PROBE_CACHE = 'civic-test-probe';
const WORKER_PROBE = `/* civic-test-probe */
self.addEventListener('message', function (event) {
  var data = event.data;
  var kind = data && data.type === 'SKIP_WAITING' ? 'skip-waiting'
    : data && data.type === 'CIVIC_WINDOW_CLIENTS' ? 'clients-query' : null;
  if (!kind) return;
  var at = Date.now();
  event.waitUntil(caches.open('${PROBE_CACHE}').then(function (cache) {
    return cache.put('/' + kind + '/' + at + '-' + Math.random().toString(36).slice(2), new Response(String(at)));
  }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (found) {
    var windows = found.map(function (client) { var url = new URL(client.url); return url.pathname + url.hash; });
    return caches.open('${PROBE_CACHE}').then(function (cache) {
      return cache.put('/activated', new Response(JSON.stringify({ at: Date.now(), windows: windows })));
    });
  }));
});
`;

/** Worker-script transform that prepends the probe. */
export const withProbe = (script: string): string => `${WORKER_PROBE}${script}`;

export interface ProbeRecord {
  /** Arrival times, in the worker, of skip-waiting messages. */
  readonly skipWaiting: readonly number[];
  /** Arrival times, in the worker, of window-awareness queries. */
  readonly queries: readonly number[];
  /** Windows (path and fragment) that existed when the probed worker activated; null if it did not. */
  readonly activatedWith: readonly string[] | null;
}

export async function readProbe(page: Page): Promise<ProbeRecord> {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
    const times = (prefix: string): number[] =>
      keys
        .filter((key) => key.startsWith(prefix))
        .map((key) => Number(key.slice(prefix.length).split('-')[0]))
        .sort((a, b) => a - b);
    const activated = await cache.match('/activated');
    const record = activated ? ((await activated.json()) as { windows: string[] }) : null;
    return {
      skipWaiting: times('/skip-waiting/'),
      queries: times('/clients-query/'),
      activatedWith: record ? record.windows.sort() : null,
    };
  }, PROBE_CACHE);
}

/*
 * Replacement protocol scripts for the fail-closed tests. Each is served as `/sw-client-awareness.js`
 * to the NEW worker only, and answers the window query wrongly in one specific way.
 */
const answerAfter = (delayMs: number, reply: string): string => `
self.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'CIVIC_WINDOW_CLIENTS' || !event.ports || !event.ports[0]) return;
  var port = event.ports[0];
  event.waitUntil(new Promise(function (resolve) {
    setTimeout(function () { port.postMessage(${reply}); resolve(); }, ${String(delayMs)});
  }));
});
`;
const SAFE_LOOKING =
  "{ type: 'CIVIC_WINDOW_CLIENTS_RESULT', version: 1, worker: 'installed', windows: [{ requester: true, kind: 'application', route: 'dashboard', visibility: 'visible', focused: true }] }";

export const PROTOCOL_VARIANTS = {
  /** Receives the query and never answers. */
  silent: `self.addEventListener('message', function () {});\n`,
  /** Answers "safe", but only after the page has stopped waiting. */
  late: answerAfter(6_000, SAFE_LOOKING),
  /** Answers with a list that is not a list. */
  malformed: answerAfter(
    0,
    "{ type: 'CIVIC_WINDOW_CLIENTS_RESULT', version: 1, worker: 'installed', windows: 'none' }",
  ),
  /** Answers in a protocol version the page does not know. */
  newerVersion: answerAfter(0, SAFE_LOOKING.replace('version: 1', 'version: 2')),
} as const;

/** The generated worker's import of the protocol; replacing it with `void 0` keeps the script valid. */
export const PROTOCOL_IMPORT = 'importScripts("sw-client-awareness.js")';

export async function entryScript(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') ?? null,
  );
}
