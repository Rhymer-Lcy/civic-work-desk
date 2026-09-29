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

/**
 * Emit `app-generation.json`: which application generation this build is (Phase 5.1).
 *
 * The generation is `ui-` followed by the content hash the bundler gives the entry chunk
 * (`assets/index-<hash>.js`). That hash changes with the entry's own code, with the hashed names of
 * every chunk it imports, and with the entry stylesheet: a CSS-only change moved it from `Czjj00lG` to
 * `BVfqecLS` (2026-09-29). The running page derives the same value from its own module URL
 * (`src/app/pwa/runtime-generation.ts`), and a deployment server reads this file to say which
 * generation it expects. The file is written after the hash is known and nothing in the bundle reads
 * it, so there is no circular dependency. It is not precached: `globPatterns` has no `.json`.
 *
 * Fails the build if the entry chunk is not exactly one `assets/index-<hash>.js`, because both sides
 * of the comparison rest on that name.
 */
function emitAppGeneration(): Plugin {
  return {
    name: 'civic-app-generation',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).filter((item) => item.type === 'chunk' && item.isEntry);
      const fileName = entries.length === 1 ? entries[0]?.fileName : undefined;
      const match =
        fileName === undefined ? null : /^assets\/index-([A-Za-z0-9_-]{6,64})\.js$/.exec(fileName);
      if (fileName === undefined || match?.[1] === undefined) {
        const found = entries.map((entry) => entry.fileName).join(', ') || 'none';
        throw new Error(
          `civic-app-generation: expected one entry chunk named assets/index-<hash>.js, found ${found}`,
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: 'app-generation.json',
        source: `${JSON.stringify(
          { schema: 'civic-app-generation/1', appGeneration: `ui-${match[1]}`, entry: fileName },
          null,
          2,
        )}\n`,
      });
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
    emitAppGeneration(),
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
        /*
         * Same-origin window awareness for a WAITING worker (Phase 5.1): answers, without any URL,
         * which windows of this origin are open, so an update page can refuse to activate while other
         * application windows hold unsaved input. Plain script in `public/`; see its header and
         * docs/phase-5.1-runtime-update-safety.md.
         */
        importScripts: ['sw-client-awareness.js'],
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
