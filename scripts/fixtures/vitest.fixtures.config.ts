import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the fixture generators only.
 *
 * The main `vitest.config.ts` includes `tests/unit` and `tests/integration` and nothing else, which
 * is deliberate: a generator writes files as a side effect and must never run as part of
 * `npm run test:unit`. Rather than widen that include (and have every suite run rewrite a committed
 * fixture), the generators get their own config and an explicit command:
 *
 * ```bash
 * npx vitest run --config scripts/fixtures/vitest.fixtures.config.ts
 * ```
 *
 * The environment, the setup file and the `@` alias are the same as the main config, because the
 * generator drives the real repositories against a real (in-memory) IndexedDB and depends on the
 * pinned clock in the shared setup for determinism.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    root: fileURLToPath(new URL('../..', import.meta.url)),
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    include: ['scripts/fixtures/**/*.test.ts'],
  },
});
