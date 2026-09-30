import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  businessDateUtc8,
  deriveReleaseIdentity,
  loadReleaseIdentity,
  RELEASE_ID_PATTERN,
} from '../../scripts/windows/release-identity.mjs';
import type {
  PublishedReleases,
  RejectedReleases,
} from '../../scripts/windows/release-identity.mjs';

/**
 * The Windows release identity is required, checked against what it claims, and never defaulted.
 *
 * Until Phase 6 the build defaulted to an already-published RC3 id and the resource generator to RC2's;
 * these tests pin that no id -- missing, malformed, stale, future-dated, mismatched with package.json,
 * already published, or rejected before publication -- becomes the identity of a new artifact.
 */

const IDENTITY = {
  productNameZh: '政务工作记录台',
  productNameEn: 'CivicWorkDesk',
  publisherDisplayName: 'Rhymer-Lcy',
};
const PUBLISHED = JSON.parse(
  readFileSync('scripts/windows/published-releases.json', 'utf8'),
) as PublishedReleases;
const REJECTED = JSON.parse(
  readFileSync('scripts/windows/rejected-releases.json', 'utf8'),
) as RejectedReleases;
/** The one candidate rejected before publication (Phase 6, first build). */
const REJECTED_ID = '2026.09.29-win-0.2.0-rc.1';
/**
 * The frozen Phase-6 candidate. The derivation tests below build it, which was valid until it was
 * published; so they derive against the registry as it stood before its publication, and the tests of
 * spent ids use the real registry, where a published id is refused for a build.
 */
const THIS_RELEASE = '2026.09.30-win-0.2.0-rc.1';
const PUBLISHED_BEFORE_THIS_RELEASE: PublishedReleases = {
  ...PUBLISHED,
  releases: PUBLISHED.releases.filter((release) => release.releaseId !== THIS_RELEASE),
};

function derive(releaseId: unknown, overrides: Record<string, unknown> = {}) {
  return deriveReleaseIdentity({
    releaseId,
    packageVersion: '0.2.0-rc.1',
    identity: IDENTITY,
    published: PUBLISHED_BEFORE_THIS_RELEASE,
    rejected: REJECTED,
    today: '2026.09.30',
    ...overrides,
  });
}

describe('release identity', () => {
  it('derives every name from one id and package.json', () => {
    const id = derive('2026.09.30-win-0.2.0-rc.1');
    expect(id).toMatchObject({
      releaseId: '2026.09.30-win-0.2.0-rc.1',
      productVersion: '0.2.0',
      displayVersion: '0.2.0-rc.1',
      windowsVersion: '0.2.0.0',
      publisher: 'Rhymer-Lcy',
      appVerName: '政务工作记录台 0.2.0-rc.1',
      installerName: 'CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe',
      payloadName: 'civic-work-desk-windows-x64-2026.09.30-win-0.2.0-rc.1',
      tagName: 'windows-v0.2.0-rc.1',
    });
    expect(RELEASE_ID_PATTERN.test(id.releaseId)).toBe(true);
  });

  it('has no default: a missing or empty id is refused', () => {
    for (const missing of [undefined, null, '', 0]) {
      expect(() => derive(missing)).toThrow(/--release-id is required and has no default/);
    }
  });

  it('refuses every previously published RC id, even under the version it was built with', () => {
    for (const spent of PUBLISHED.releases) {
      expect(() => derive(spent.releaseId, { published: PUBLISHED })).toThrow(
        /release identity refused/,
      );
      expect(() =>
        derive(spent.releaseId, { published: PUBLISHED, packageVersion: '0.1.0' }),
      ).toThrow(/release identity refused/);
    }
    // RC1-RC3 all present, so none of them can slip through a shortened list; the only entry the
    // registry may hold besides them is the frozen Phase-6 candidate, once it is published.
    expect(PUBLISHED_BEFORE_THIS_RELEASE.releases.map((r) => r.releaseId)).toEqual([
      '2026.09.24-win-rc1',
      '2026.09.24-win-rc2',
      '2026.09.24-win-rc3',
    ]);
  });

  it('refuses an id whose version is not package.json#version', () => {
    expect(() => derive('2026.09.30-win-0.2.0-rc.2')).toThrow(/package.json#version is 0.2.0-rc.1/);
    expect(() => derive('2026.09.30-win-0.2.0')).toThrow(/package.json#version/);
    expect(() => derive('2026.09.30-0.2.0-rc.1')).toThrow(/YYYY.MM.DD-win-<version>/);
  });

  it('refuses shapes civic-admin would refuse, impossible dates and future dates', () => {
    expect(() => derive('2026.09.30-win-0.2.0-rc.1.')).toThrow(/shape/);
    expect(() => derive('2026.09.30-WIN-0.2.0-rc.1')).toThrow(/shape/);
    expect(() => derive('../2026.09.30-win-0.2.0-rc.1')).toThrow(/shape/);
    expect(() => derive('2026.02.30-win-0.2.0-rc.1')).toThrow(/not a calendar date/);
    expect(() => derive('2026.13.01-win-0.2.0-rc.1')).toThrow(/not a calendar date/);
    expect(() => derive('2026.10.01-win-0.2.0-rc.1')).toThrow(/later than today/);
  });

  it('refuses a display version, tag or id that has already been published', () => {
    const published: PublishedReleases = {
      releases: [
        ...PUBLISHED_BEFORE_THIS_RELEASE.releases,
        {
          releaseId: '2026.09.30-win-0.2.0-rc.1',
          tag: 'windows-v0.2.0-rc.1',
          displayVersion: '0.2.0-rc.1',
        },
      ],
    };
    expect(() => derive('2026.09.30-win-0.2.0-rc.1', { published })).toThrow(/already published/);
    // A later date does not make a spent display version new again.
    expect(() => derive('2026.09.30-win-0.2.0-rc.1', { published, today: '2026.10.02' })).toThrow(
      /already published/,
    );
    expect(() => derive('2026.10.01-win-0.2.0-rc.1', { published, today: '2026.10.02' })).toThrow(
      /display version 0.2.0-rc.1 is already published/,
    );
  });

  it('lets an audit examine the published release itself, and nothing else', () => {
    const published: PublishedReleases = {
      releases: [
        ...PUBLISHED_BEFORE_THIS_RELEASE.releases,
        {
          releaseId: '2026.09.30-win-0.2.0-rc.1',
          tag: 'windows-v0.2.0-rc.1',
          displayVersion: '0.2.0-rc.1',
        },
      ],
    };
    // The build still refuses it -- and refusing is the default when no purpose is given.
    expect(() => derive('2026.09.30-win-0.2.0-rc.1', { published })).toThrow(/already published/);
    expect(() => derive('2026.09.30-win-0.2.0-rc.1', { published, purpose: 'build' })).toThrow(
      /already published/,
    );
    // An audit of exactly that release is allowed.
    expect(derive('2026.09.30-win-0.2.0-rc.1', { published, purpose: 'audit' }).releaseId).toBe(
      '2026.09.30-win-0.2.0-rc.1',
    );
    // An audit of ANOTHER build claiming the same display version is not: that would be a second rc.1.
    expect(() =>
      derive('2026.10.01-win-0.2.0-rc.1', { published, purpose: 'audit', today: '2026.10.02' }),
    ).toThrow(/display version 0.2.0-rc.1 is already published/);
    // RC3 cannot be audited under this package version at all: its id names a different version.
    expect(() => derive('2026.09.24-win-rc3', { purpose: 'audit' })).toThrow(/package.json/);
    expect(() => derive('2026.09.30-win-0.2.0-rc.1', { purpose: 'deploy' })).toThrow(
      /unknown purpose/,
    );
  });

  it('refuses a publisher that is missing, padded, or the product name', () => {
    for (const publisherDisplayName of ['', ' Rhymer-Lcy', 'CivicWorkDesk', '政务工作记录台']) {
      expect(() =>
        derive('2026.09.30-win-0.2.0-rc.1', {
          identity: { ...IDENTITY, publisherDisplayName },
        }),
      ).toThrow(/publisher/);
    }
  });

  it('reads the repository inputs, and they agree with the policy', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    // As an audit, which the release may undergo whether or not it has been published yet.
    const id = loadReleaseIdentity('.', `2026.09.30-win-${pkg.version}`, '2026.09.30', 'audit');
    expect(id.displayVersion).toBe(pkg.version);
    expect(id.publisher).toBe('Rhymer-Lcy');
  });

  it('refuses the engineering id of a candidate rejected before publication, for any purpose', () => {
    for (const purpose of ['build', 'audit'] as const) {
      expect(() => derive(REJECTED_ID, { purpose })).toThrow(
        /was rejected before publication .* its engineering id is spent/,
      );
    }
    // The rejection did not spend its display version, so a new build could carry it under a new
    // id, as the frozen Phase-6 candidate did (derived here against the registry before that).
    expect(derive('2026.09.30-win-0.2.0-rc.1').displayVersion).toBe('0.2.0-rc.1');
    // Mutation: without its registry entry the same id would be accepted, so the refusal comes from
    // the registry and not from anything else.
    expect(derive(REJECTED_ID, { rejected: { releases: [] } }).releaseId).toBe(REJECTED_ID);
  });

  it('refuses both spent classes: published ids and rejected ids', () => {
    for (const spent of PUBLISHED.releases) {
      expect(() => derive(spent.releaseId, { published: PUBLISHED })).toThrow(
        /release identity refused/,
      );
    }
    expect(() => derive(REJECTED_ID)).toThrow(/rejected before publication/);
  });

  it('fails closed on a missing or damaged rejected-release registry', () => {
    const entry = REJECTED.releases[0];
    if (!entry) throw new Error('the registry must hold the rejected candidate');
    for (const rejected of [
      undefined,
      {},
      { releases: [{ ...entry, sha256: 'not-a-digest' }] },
      { releases: [{ ...entry, status: 'published' }] },
      { releases: [{ ...entry, reason: ' ' }] },
      { releases: [{ ...entry, releaseId: '../x' }] },
    ]) {
      expect(() => derive('2026.09.30-win-0.2.0-rc.1', { rejected })).toThrow(/rejected-releases/);
    }
  });

  it('records the rejected candidate exactly as its preserved evidence identifies it', () => {
    expect(REJECTED.releases).toEqual([
      expect.objectContaining({
        releaseId: REJECTED_ID,
        displayVersion: '0.2.0-rc.1',
        installer: 'CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe',
        size: 6951434,
        sha256: '4fe9296dbbaf20a85a19d742cfd9a7ae86a2e99c16518ec125718a66fd10eae5',
        deploymentSourceCommit: 'a31cb4396ad2b72cd830aef92e96fffa13be6053',
        status: 'rejected-before-publication',
      }),
    ]);
    // A rejected id and a published id never overlap.
    const publishedIds = new Set(PUBLISHED.releases.map((r) => r.releaseId));
    expect(REJECTED.releases.some((r) => publishedIds.has(r.releaseId))).toBe(false);
    // The repository loader applies the registry too. Once 0.2.0-rc.1 is published, the rejected id's
    // display version is spent as well and would be refused for that first, so the loader reads a copy
    // of the repository inputs whose published registry stands before that publication.
    const root = mkdtempSync(join(tmpdir(), 'civic-identity-'));
    try {
      mkdirSync(join(root, 'scripts', 'windows'), { recursive: true });
      for (const file of [
        'package.json',
        'product-identity.json',
        'scripts/windows/rejected-releases.json',
      ]) {
        writeFileSync(join(root, file), readFileSync(file));
      }
      writeFileSync(
        join(root, 'scripts', 'windows', 'published-releases.json'),
        JSON.stringify(PUBLISHED_BEFORE_THIS_RELEASE),
      );
      expect(() => loadReleaseIdentity(root, REJECTED_ID, '2026.09.30')).toThrow(
        /rejected before publication/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dates in UTC+8, not in the workstation zone', () => {
    // 2026-09-29T20:00:00-04:00 is 2026-09-30T08:00:00+08:00.
    expect(businessDateUtc8(new Date('2026-09-29T20:00:00-04:00'))).toBe('2026.09.30');
    expect(businessDateUtc8(new Date('2026-09-29T11:59:59-04:00'))).toBe('2026.09.29');
  });
});
