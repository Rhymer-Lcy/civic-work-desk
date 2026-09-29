/*
 * CivicWorkDesk service-worker extension: same-origin window awareness (Phase 5.1).
 *
 * Loaded into the generated service worker with `importScripts` (vite.config.ts,
 * `workbox.importScripts`). It answers one question, and only for a page of this origin:
 * "which windows of this origin are open right now?". A page that is about to activate a WAITING
 * worker asks that worker, because the waiting worker is the new generation and so is the one that
 * carries this protocol. The worker in control may be an older one that never heard of it.
 *
 * Why it exists: activating a worker makes it the controller of every open page at once, and pages
 * running an older generation (RC3 and earlier) reload themselves when that happens, taking any unsaved
 * input with them. A future update page can use the answer to refuse activation while other application
 * windows are open, and ask the user to save and close them first. See
 * docs/phase-5.1-runtime-update-safety.md for the contract and for the measurements showing that a
 * waiting worker sees windows controlled by the old worker, uncontrolled ones and background ones.
 *
 * Privacy: the answer carries no URL. Each window is reduced to a fixed classification (application,
 * bootstrap, platform, service or outside-scope), one of the six route names or null, and the
 * visibility and focus flags the browser already reports. Query strings, fragments beyond the route
 * name, titles and anything a page holds are never read or returned. Messages from another origin,
 * and messages that are not exactly this request, are ignored without a reply.
 *
 * Request:  registration.waiting.postMessage({ type: 'CIVIC_WINDOW_CLIENTS', version: 1 }, [port2])
 * Reply on port1: { type: 'CIVIC_WINDOW_CLIENTS_RESULT', version: 1, worker: <state>,
 *                   windows: [{ requester, kind, route, visibility, focused }] }
 *
 * A classic script with no imports, because it runs inside the worker before Workbox's own code.
 */
(function civicWindowClientAwareness(scope) {
  'use strict';

  const REQUEST = 'CIVIC_WINDOW_CLIENTS';
  const RESULT = 'CIVIC_WINDOW_CLIENTS_RESULT';
  const VERSION = 1;
  const ROUTES = ['dashboard', 'work', 'honors', 'ledger', 'reports', 'settings'];

  function isRequest(data) {
    if (data === null || typeof data !== 'object') return false;
    return Object.keys(data).length === 2 && data.type === REQUEST && data.version === VERSION;
  }

  /** A window's URL reduced to what the protocol may disclose; null for another origin. */
  function classify(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.origin !== scope.location.origin) return null;
    const base = new URL(scope.registration.scope).pathname;
    if (!url.pathname.startsWith(base)) return { kind: 'outside-scope', route: null };
    const path = '/' + url.pathname.slice(base.length);
    /*
     * Only `/api/` is exempt from the navigation fallback (navigateFallbackDenylist), so only a window
     * there is certainly not the application. Every other path in scope can be: under a controlling
     * worker even `/__civic/platform` is answered with the application shell (measured on the Phase-6
     * candidate, 2026-09-29), so it is counted as an application window like any other.
     */
    if (path === '/api/civic/start') return { kind: 'bootstrap', route: null };
    if (path === '/api/civic/platform') return { kind: 'platform', route: null };
    if (path.startsWith('/api/')) return { kind: 'service', route: null };
    const match = /^#\/+([a-z]+)/.exec(url.hash);
    const route = match && ROUTES.includes(match[1]) ? match[1] : null;
    return { kind: 'application', route };
  }

  scope.addEventListener('message', (event) => {
    if (!isRequest(event.data)) return;
    const port = event.ports?.[0];
    if (!port) return;
    const source = event.source;
    if (!source || typeof source.url !== 'string' || classify(source.url) === null) return;

    event.waitUntil(
      scope.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((found) => {
        const windows = [];
        for (const client of found) {
          const place = classify(client.url);
          if (place === null) continue;
          windows.push({
            requester: client.id === source.id,
            kind: place.kind,
            route: place.route,
            visibility: client.visibilityState === 'hidden' ? 'hidden' : 'visible',
            focused: client.focused === true,
          });
        }
        port.postMessage({
          type: RESULT,
          version: VERSION,
          worker: scope.serviceWorker ? scope.serviceWorker.state : 'unknown',
          windows,
        });
      }),
    );
  });
})(self);
