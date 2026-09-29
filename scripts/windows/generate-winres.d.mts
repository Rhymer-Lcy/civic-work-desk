/** Type declarations for generate-winres.mjs, so TypeScript tests can import its version writer. */
import type { ProductVersion } from './product-version.mjs';

export function buildVersionResource(
  target: { readonly description: string; readonly internal: string; readonly original: string },
  version: ProductVersion,
  releaseId: string,
): Buffer;
