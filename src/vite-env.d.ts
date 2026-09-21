/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * CSS module typing.
 *
 * Deliberately NOT declared here as `Record<string, string>`. Per-stylesheet declarations are
 * generated into `*.module.css.d.ts` by `scripts/generate-css-module-types.mjs`, so `styles.card`
 * is a checked property rather than an index-signature lookup. See that script's header for why.
 */
export {};
