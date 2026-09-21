import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration.
 *
 * Tests run against the **production build** served by `vite preview`, not the dev server. That is
 * deliberate: the service worker, the real manifest, the CSP meta tag and the lazy export chunks
 * only exist in a production build, and three of the mandatory flows (offline reload, install
 * metadata, external-network assertion) are meaningless without them.
 *
 * `127.0.0.1` rather than `localhost` so the origin is stable and unambiguous in request
 * assertions, and so it qualifies as a secure context for Storage and Service Worker APIs.
 */

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI']
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // Every test starts from a clean origin; the app seeds itself on first run.
    storageState: undefined,
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: ['**/responsive.spec.ts', '**/smoke.spec.ts'],
    },
    {
      name: 'a11y',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
      testMatch: ['**/accessibility.spec.ts'],
    },
    /*
     * Cross-engine verification, deliberately narrow.
     *
     * Only `cross-browser.spec.ts` runs here — the critical flows whose implementations differ
     * most between engines (IndexedDB durability, blob download, file input, date-only rendering,
     * dynamic import). Running the whole suite three times would triple the wall clock to
     * re-assert behaviour that is engine-independent.
     *
     * `webkit-desktop` is Playwright's WebKit on Windows. It is **not** Safari and not iOS: the
     * same WebCore, but different OS integration, storage eviction, install path and input
     * behaviour. It is evidence about the engine, not about the product on Apple platforms — the
     * manual matrix in docs/qa-plan.md carries that, and a real-device PASS is never inferred
     * from this project.
     */
    {
      name: 'firefox-desktop',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
      testMatch: ['**/cross-browser.spec.ts'],
    },
    {
      name: 'webkit-desktop',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
      testMatch: ['**/cross-browser.spec.ts'],
    },
  ],

  webServer: {
    command: 'npm run preview',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
