/** Type declarations for release-identity.mjs, so TypeScript tests can import it. */
export interface ReleaseIdentity {
  readonly releaseId: string;
  readonly releaseDate: string;
  readonly productVersion: string;
  readonly displayVersion: string;
  readonly windowsVersion: string;
  readonly windowsParts: readonly [number, number, number, number];
  readonly prerelease: readonly string[];
  readonly publisher: string;
  readonly productNameZh: string;
  readonly productNameEn: string;
  readonly appVerName: string;
  readonly setupBase: string;
  readonly installerName: string;
  readonly payloadName: string;
  readonly tagName: string;
}

export interface PublishedRelease {
  readonly releaseId: string;
  readonly tag: string;
  readonly displayVersion?: string;
}

export interface PublishedReleases {
  readonly releases: readonly PublishedRelease[];
}

export interface RejectedRelease {
  readonly releaseId: string;
  readonly displayVersion: string;
  readonly sha256: string;
  readonly status: string;
  readonly reason: string;
  readonly installer?: string;
  readonly size?: number;
  readonly deploymentSourceCommit?: string;
  readonly productBaselineCommit?: string;
  readonly rejectedOn?: string;
}

export interface RejectedReleases {
  readonly releases: readonly RejectedRelease[];
}

export const RELEASE_ID_PATTERN: RegExp;

export function businessDateUtc8(now?: Date): string;

export function deriveReleaseIdentity(input: {
  readonly releaseId: unknown;
  readonly packageVersion: string;
  readonly identity: {
    readonly productNameZh: string;
    readonly productNameEn: string;
    readonly publisherDisplayName: string;
  };
  readonly published: PublishedReleases;
  readonly rejected: RejectedReleases;
  readonly today: string;
  readonly purpose?: ReleasePurpose;
}): ReleaseIdentity;

/** `build` refuses every published identity; `audit` accepts the one that is this release. */
export type ReleasePurpose = 'build' | 'audit';

export function loadReleaseIdentity(
  root: string,
  releaseId: unknown,
  today?: string,
  purpose?: ReleasePurpose,
): ReleaseIdentity;
