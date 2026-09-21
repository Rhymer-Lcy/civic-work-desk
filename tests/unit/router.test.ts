import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE,
  ROUTES,
  ROUTE_LABELS_ZH,
  isRouteId,
  normaliseHash,
  parseHash,
  routeHref,
} from '@/app/router';

/**
 * Hash routing.
 *
 * Phase 1's normalisation guard read `window.location.hash === '' ||
 * !isRouteId(parseHash(window.location.hash))`. The second clause is unreachable — `parseHash`
 * falls back to `DEFAULT_ROUTE`, so its result is a `RouteId` by construction. Only an empty hash
 * was ever normalised: `#/nonsense` rendered the dashboard while the address bar still said
 * `#/nonsense`, so the URL a user bookmarked or shared named no view at all.
 */

describe('parseHash', () => {
  it('resolves every declared route', () => {
    for (const route of ROUTES) {
      expect(parseHash(`#/${route}`)).toBe(route);
    }
  });

  it('falls back to the default route for anything unrecognised', () => {
    expect(parseHash('')).toBe(DEFAULT_ROUTE);
    expect(parseHash('#')).toBe(DEFAULT_ROUTE);
    expect(parseHash('#/')).toBe(DEFAULT_ROUTE);
    expect(parseHash('#/nonsense')).toBe(DEFAULT_ROUTE);
    expect(parseHash('#/work/detail/1')).toBe(DEFAULT_ROUTE);
    expect(parseHash('#/WORK')).toBe(DEFAULT_ROUTE);
  });

  it('tolerates the shapes a hand-typed or legacy link takes', () => {
    expect(parseHash('#work')).toBe('work');
    expect(parseHash('#//work')).toBe('work');
    expect(parseHash('#/work/')).toBe('work');
    expect(parseHash('#/work?filter=open')).toBe('work');
  });
});

describe('normaliseHash', () => {
  it('leaves an already-canonical hash untouched, so no redirect loop is possible', () => {
    for (const route of ROUTES) {
      const href = routeHref(route);
      expect(normaliseHash(href)).toBe(href);
      // Idempotent: normalising the normalised form changes nothing.
      expect(normaliseHash(normaliseHash(href))).toBe(href);
    }
  });

  it('REGRESSION: an unknown hash normalises to the route actually rendered', () => {
    // Phase 1 rendered the dashboard here and left the address bar reading `#/nonsense`.
    expect(normaliseHash('#/nonsense')).toBe(routeHref(DEFAULT_ROUTE));
    expect(parseHash('#/nonsense')).toBe(DEFAULT_ROUTE);
    // The two must agree — that agreement is the whole invariant.
    expect(normaliseHash('#/nonsense')).toBe(routeHref(parseHash('#/nonsense')));
  });

  it('normalises an empty or bare hash', () => {
    expect(normaliseHash('')).toBe(routeHref(DEFAULT_ROUTE));
    expect(normaliseHash('#')).toBe(routeHref(DEFAULT_ROUTE));
    expect(normaliseHash('#/')).toBe(routeHref(DEFAULT_ROUTE));
  });

  it('REGRESSION: repairs a sloppy but resolvable hash instead of redirecting away from it', () => {
    expect(normaliseHash('#work')).toBe('#/work');
    expect(normaliseHash('#//work')).toBe('#/work');
    expect(normaliseHash('#/work/')).toBe('#/work');
  });

  it('keeps a query string on a known route and discards one on an unknown route', () => {
    expect(normaliseHash('#/work?filter=open')).toBe('#/work?filter=open');
    expect(normaliseHash('#work?filter=open')).toBe('#/work?filter=open');
    // The query described a path that names no view, so it goes with the path.
    expect(normaliseHash('#/nonsense?filter=open')).toBe(routeHref(DEFAULT_ROUTE));
  });

  it('the invariant holds for every input: the canonical hash parses to the same route', () => {
    const inputs = [
      '',
      '#',
      '#/',
      '#work',
      '#//work',
      '#/work/',
      '#/work?filter=open',
      '#/nonsense',
      '#/nonsense?x=1',
      '#/settings',
      '#/WORK',
      '#/work/detail/1',
    ];
    for (const input of inputs) {
      expect(parseHash(normaliseHash(input)), input).toBe(parseHash(input));
      expect(normaliseHash(normaliseHash(input)), input).toBe(normaliseHash(input));
    }
  });
});

describe('route metadata', () => {
  it('every route has a Chinese label and passes its own guard', () => {
    for (const route of ROUTES) {
      expect(ROUTE_LABELS_ZH[route]).toBeTruthy();
      expect(isRouteId(route)).toBe(true);
    }
    expect(Object.keys(ROUTE_LABELS_ZH)).toHaveLength(ROUTES.length);
    expect(isRouteId('nonsense')).toBe(false);
  });
});
