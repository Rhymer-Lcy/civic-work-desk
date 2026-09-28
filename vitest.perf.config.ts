import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Scale measurements, kept apart from the unit and integration suites.
 *
 * They print timings rather than assert them, take several seconds, and would add noise to the
 * ordinary `npm test` run. The domain code they exercise is DOM-free, so a Node environment is used.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/perf/**/*.perf.test.ts'],
    testTimeout: 120_000,
  },
});
