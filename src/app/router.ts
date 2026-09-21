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

export function parseHash(hash: string): RouteId {
  const cleaned = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return isRouteId(cleaned) ? cleaned : DEFAULT_ROUTE;
}

export function routeHref(route: RouteId): string {
  return `#/${route}`;
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
    // Normalise an empty or unknown hash so the address bar always reflects the rendered view.
    if (window.location.hash === '' || !isRouteId(parseHash(window.location.hash))) {
      window.location.replace(routeHref(parseHash(window.location.hash)));
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
