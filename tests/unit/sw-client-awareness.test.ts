import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * The service-worker window-awareness protocol, in isolation (Phase 5.1).
 *
 * `public/sw-client-awareness.js` runs inside the service worker, so it is loaded here into a bare
 * context whose `self` offers only what the script uses. That makes the privacy contract checkable
 * without a browser: the reply may carry a fixed classification per window and nothing that came from
 * a URL beyond one of the six route names, and anything that is not exactly the request, or that comes
 * from another origin, gets no reply at all. The browser-level question (does a WAITING worker see the
 * windows the old worker controls?) is tests/e2e/client-awareness.spec.ts.
 */

const SOURCE = readFileSync('public/sw-client-awareness.js', 'utf8');
const ORIGIN = 'http://127.0.0.1:8765';
const REQUEST = { type: 'CIVIC_WINDOW_CLIENTS', version: 1 };

interface FakeClient {
  readonly id: string;
  readonly url: string;
  readonly visibilityState?: string;
  readonly focused?: boolean;
}

interface Delivery {
  readonly posted: unknown[];
  readonly matchAll: ReturnType<typeof vi.fn>;
}

function load(options: { clients: FakeClient[]; scope?: string }): {
  deliver: (event: {
    data: unknown;
    source?: FakeClient | null;
    ports?: unknown[];
  }) => Promise<Delivery>;
} {
  let listener: ((event: unknown) => void) | undefined;
  const matchAll = vi.fn(() => Promise.resolve(options.clients));
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: options.scope ?? `${ORIGIN}/` },
    serviceWorker: { state: 'installed' },
    clients: { matchAll },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      if (type === 'message') listener = handler;
    },
  };
  runInNewContext(SOURCE, { self, URL });
  if (!listener) throw new Error('the script registered no message listener');
  const handler = listener;

  return {
    async deliver(event) {
      const posted: unknown[] = [];
      const waits: Promise<unknown>[] = [];
      const port = {
        postMessage: (message: unknown) => posted.push(message),
      };
      handler({
        data: event.data,
        source: event.source === undefined ? options.clients[0] : event.source,
        ports: event.ports ?? [port],
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      });
      await Promise.all(waits);
      return { posted, matchAll };
    },
  };
}

const WINDOWS: FakeClient[] = [
  {
    id: 'boot',
    url: `${ORIGIN}/api/civic/start?token=SECRET-START`,
    visibilityState: 'visible',
    focused: true,
  },
  { id: 'a', url: `${ORIGIN}/#/work`, visibilityState: 'hidden', focused: false },
  {
    id: 'b',
    url: `${ORIGIN}/?q=SECRET-QUERY#/ledger?note=SECRET-HASH`,
    visibilityState: 'visible',
  },
  { id: 'c', url: `${ORIGIN}/index.html#/unknown-view` },
  { id: 'd', url: `${ORIGIN}/__civic/platform` },
  { id: 'e', url: `${ORIGIN}/api/civic/platform` },
  { id: 'f', url: `${ORIGIN}/api/civic/runtime` },
  { id: 'g', url: 'http://127.0.0.1:9999/#/work' },
];

describe('sw-client-awareness.js', () => {
  it('answers the request with a URL-free classification of every window of the origin', async () => {
    const { deliver } = load({ clients: WINDOWS });
    const { posted, matchAll } = await deliver({ data: REQUEST });

    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(posted).toEqual([
      {
        type: 'CIVIC_WINDOW_CLIENTS_RESULT',
        version: 1,
        worker: 'installed',
        windows: [
          { requester: true, kind: 'bootstrap', route: null, visibility: 'visible', focused: true },
          {
            requester: false,
            kind: 'application',
            route: 'work',
            visibility: 'hidden',
            focused: false,
          },
          {
            requester: false,
            kind: 'application',
            route: 'ledger',
            visibility: 'visible',
            focused: false,
          },
          {
            requester: false,
            kind: 'application',
            route: null,
            visibility: 'visible',
            focused: false,
          },
          // Under a controlling worker this path is answered with the application shell.
          {
            requester: false,
            kind: 'application',
            route: null,
            visibility: 'visible',
            focused: false,
          },
          {
            requester: false,
            kind: 'platform',
            route: null,
            visibility: 'visible',
            focused: false,
          },
          { requester: false, kind: 'service', route: null, visibility: 'visible', focused: false },
          // The window on another origin is not reported at all.
        ],
      },
    ]);
    const text = JSON.stringify(posted);
    for (const secret of [
      'SECRET',
      'token',
      'note',
      '127.0.0.1',
      'http',
      'unknown-view',
      '__civic',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('marks outside-scope windows when the worker is scoped below the origin root', async () => {
    const clients: FakeClient[] = [
      { id: 'self', url: `${ORIGIN}/app/api/civic/start` },
      { id: 'in', url: `${ORIGIN}/app/#/honors` },
      { id: 'out', url: `${ORIGIN}/elsewhere/#/honors` },
    ];
    const { deliver } = load({ clients, scope: `${ORIGIN}/app/` });
    const { posted } = await deliver({ data: REQUEST });
    const windows = (posted[0] as { windows: { kind: string; route: string | null }[] }).windows;
    expect(windows.map((entry) => `${entry.kind}:${String(entry.route)}`)).toEqual([
      'bootstrap:null',
      'application:honors',
      'outside-scope:null',
    ]);
  });

  it.each([
    ['another message type', { type: 'SKIP_WAITING' }],
    ['another version', { type: 'CIVIC_WINDOW_CLIENTS', version: 2 }],
    ['an extra field', { type: 'CIVIC_WINDOW_CLIENTS', version: 1, include: 'urls' }],
    ['a string', 'CIVIC_WINDOW_CLIENTS'],
    ['null', null],
  ])('ignores %s: no enumeration, no reply', async (_label, data) => {
    const { deliver } = load({ clients: WINDOWS });
    const { posted, matchAll } = await deliver({ data });
    expect(matchAll).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('ignores a request without a reply port', async () => {
    const { deliver } = load({ clients: WINDOWS });
    const { posted, matchAll } = await deliver({ data: REQUEST, ports: [] });
    expect(matchAll).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('ignores a request whose source is on another origin or has no URL', async () => {
    const { deliver } = load({ clients: WINDOWS });
    for (const source of [{ id: 'x', url: 'http://127.0.0.1:9999/' }, null]) {
      const { posted, matchAll } = await deliver({ data: REQUEST, source });
      expect(matchAll).not.toHaveBeenCalled();
      expect(posted).toEqual([]);
    }
  });
});
