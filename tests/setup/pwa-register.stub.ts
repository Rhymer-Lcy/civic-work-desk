/**
 * Stand-in for vite-plugin-pwa's `virtual:pwa-register`, which exists only in a Vite build that runs the
 * plugin. `vitest.config.ts` resolves the specifier here so modules that import it can be loaded; a unit
 * test that needs registration replaces it with `vi.doMock`. Reaching this body means one forgot to.
 */
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  throw new Error('virtual:pwa-register is not available in unit tests; mock it with vi.doMock');
}
