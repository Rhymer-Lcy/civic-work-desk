import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * CivicWorkDesk build configuration.
 *
 * Deliberate choices:
 * - `base: './'` keeps the bundle portable across sub-path hosting and `vite preview`.
 * - No CDN, no remote font, no analytics: every asset is emitted locally.
 * - Heavy report writers (ExcelJS, docx) are forced into their own async chunks so they
 *   never land in the initial payload. See docs/architecture.md.
 * - The service worker precaches the application shell only. `navigateFallbackDenylist`
 *   and the absence of any runtime caching rule keep user data out of the Cache API.
 * - No source maps in the production build, and a strict `style-src` that the dev server
 *   relaxes for itself alone. Both are explained where they are configured below.
 */

/**
 * Relax `style-src` for the dev server only.
 *
 * `index.html` ships `style-src 'self'` — no 'unsafe-inline' anywhere in the policy. Vite's dev
 * server injects CSS as inline `<style>` elements for hot replacement, which that directive
 * correctly blocks, so `vite dev` would render unstyled. Rather than weaken the artifact that is
 * actually deployed, the relaxation is applied at serve time and never at build time. `vite
 * preview` serves the built files, so the e2e suite always sees the strict policy.
 *
 * It fails loudly when the directive it expects is absent: a silent no-op would leave the dev
 * server unstyled with no explanation, and would also hide a later loosening of the real policy.
 */
function relaxDevStyleCsp(): Plugin {
  const strict = "style-src 'self';";
  return {
    name: 'civic-relax-dev-style-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      // Exactly one occurrence, because `String.replace` with a string pattern rewrites only the
      // first: a second copy of the directive (in a comment, say) would make the substitution
      // land in the wrong place and leave the real policy untouched.
      const occurrences = html.split(strict).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `civic-relax-dev-style-csp: expected exactly one "${strict}" in index.html, found ` +
            `${String(occurrences)}. The CSP meta tag changed shape; update this plugin ` +
            'deliberately rather than letting the dev server diverge from the shipped policy.',
        );
      }
      return html.replace(strict, "style-src 'self' 'unsafe-inline';");
    },
  };
}

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2023',
    /*
     * No source maps in a build that gets handed to someone else.
     *
     * Phase 1 set `sourcemap: true`, so `dist/` carried `.map` files reproducing the complete
     * TypeScript source — including the Chinese UI strings, the legacy-migration heuristics and
     * every comment — and the bundles pointed at them with `//# sourceMappingURL`. For a
     * single-origin local-first app that is pure disclosure with no operational benefit: there is
     * no error-reporting service consuming them, and a developer debugging the app runs the dev
     * server, where maps are always available.
     *
     * Consequence to accept, not to work around: a stack trace from a production bundle is
     * minified. Reproduce the fault against `npm run dev` instead.
     */
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('exceljs')) return 'vendor-xlsx';
            if (id.includes('/docx/') || id.includes('node_modules/docx')) return 'vendor-docx';
            if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
              return 'vendor-react';
            }
            if (id.includes('dexie')) return 'vendor-db';
            if (id.includes('zod')) return 'vendor-schema';
            if (id.includes('date-fns')) return 'vendor-date';
            if (id.includes('lucide-react')) return 'vendor-icons';
          }
          return undefined;
        },
      },
    },
  },
  plugins: [
    react(),
    relaxDevStyleCsp(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      manifestFilename: 'manifest.webmanifest',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Application shell only. No runtimeCaching entry exists on purpose:
        // records, backups and generated reports must never enter the Cache API.
        runtimeCaching: [],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },
});
