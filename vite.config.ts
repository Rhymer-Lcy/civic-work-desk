import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
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
 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
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
