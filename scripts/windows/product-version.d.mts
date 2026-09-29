/** Type declarations for product-version.mjs, so TypeScript tests can import it. */
export interface ProductVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly productVersion: string;
  readonly displayVersion: string;
  readonly windowsVersion: string;
  readonly windowsParts: readonly [number, number, number, number];
}

export function parseProductVersion(text: string): ProductVersion;
