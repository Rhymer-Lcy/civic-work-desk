import { useCallback, useEffect, useState } from 'react';

/**
 * Hash routing.
 *
 * Hash-based rather than history-based so the built bundle works unchanged from a sub-path, from
 * `vite preview`, and from any static host without a rewrite rule — which is the whole point of
 * the `base: './'` build. Six routes and no nesting do not justify a router dependency; this is
 * the entire implementation and it is directly testable.
 */

export const ROUTES = ['dashboard', 'work', 'honors', 'ledger', 'reports', 'settings'] as const;

export type RouteId = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: RouteId = 'dashboard';

export const ROUTE_LABELS_ZH: Readonly<Record<RouteId, string>> = Object.freeze({
  dashboard: '概览',
  work: '工作',
  honors: '荣誉',
  ledger: '台账',
  reports: '报告',
  settings: '设置',
});

export function isRouteId(value: string): value is RouteId {
  return (ROUTES as readonly string[]).includes(value);
}

/**
 * Split a raw hash into the route path and the query string that follows it.
 *
 * Tolerates the shapes a hand-typed or legacy link actually takes — a missing slash (`#work`),
 * repeated slashes (`#//work`), a trailing slash (`#/work/`) — so all of them resolve to the same
 * route instead of silently falling back to the default.
 */
function splitHash(hash: string): { readonly path: string; readonly query: string } {
  const raw = hash.replace(/^#\/*/, '');
  const queryIndex = raw.indexOf('?');
  const path = (queryIndex === -1 ? raw : raw.slice(0, queryIndex)).replace(/\/+$/, '');
  const query = queryIndex === -1 ? '' : raw.slice(queryIndex);
  return { path, query };
}

export function parseHash(hash: string): RouteId {
  const { path } = splitHash(hash);
  return isRouteId(path) ? path : DEFAULT_ROUTE;
}

export function routeHref(route: RouteId): string {
  return `#/${route}`;
}

/**
 * The canonical hash for whatever a raw hash resolves to.
 *
 * This is the comparison the normalisation in `useRoute` needs. Phase 1 instead tested
 * `!isRouteId(parseHash(hash))`, which can never be true: `parseHash` already falls back to
 * `DEFAULT_ROUTE`, so its result is a `RouteId` by construction. Only an empty hash was ever
 * normalised, and `#/nonsense` rendered the dashboard while the address bar kept claiming
 * `#/nonsense` — so reloading or bookmarking the page preserved a URL that named no view.
 *
 * A query string belongs to the path it was written on: a known route keeps it, an unknown route
 * is discarded whole.
 */
export function normaliseHash(hash: string): string {
  const { path, query } = splitHash(hash);
  return isRouteId(path) ? `#/${path}${query}` : routeHref(DEFAULT_ROUTE);
}

export function useRoute(): { route: RouteId; navigate: (route: RouteId) => void } {
  const [route, setRoute] = useState<RouteId>(() =>
    typeof window === 'undefined' ? DEFAULT_ROUTE : parseHash(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    // Normalise an empty, sloppy or unknown hash so the address bar always names the rendered view.
    const canonical = normaliseHash(window.location.hash);
    if (window.location.hash !== canonical) {
      window.location.replace(canonical);
    }
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const navigate = useCallback((next: RouteId) => {
    if (parseHash(window.location.hash) === next) return;
    window.location.hash = `/${next}`;
  }, []);

  return { route, navigate };
}
