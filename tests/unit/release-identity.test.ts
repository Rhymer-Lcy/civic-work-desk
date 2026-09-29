import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  businessDateUtc8,
  deriveReleaseIdentity,
  loadReleaseIdentity,
  RELEASE_ID_PATTERN,
} from '../../scripts/windows/release-identity.mjs';
import type { PublishedReleases } from '../../scripts/windows/release-identity.mjs';

/**
 * The Windows release identity is required, checked against what it claims, and never defaulted.
 *
 * Until Phase 6 the build defaulted to an already-published RC3 id and the resource generator to RC2's;
 * these tests pin that no id -- missing, malformed, stale, future-dated, mismatched with package.json, or
 * already published -- becomes the identity of a new artifact.
 */

const IDENTITY = {
  productNameZh: '政务工作记录台',
  productNameEn: 'CivicWorkDesk',
  publisherDisplayName: 'Rhymer-Lcy',
};
const PUBLISHED = JSON.parse(
  readFileSync('scripts/windows/published-releases.json', 'utf8'),
) as PublishedReleases;

function derive(releaseId: unknown, overrides: Record<string, unknown> = {}) {
  return deriveReleaseIdentity({
    releaseId,
    packageVersion: '0.2.0-rc.1',
    identity: IDENTITY,
    published: PUBLISHED,
    today: '2026.09.29',
    ...overrides,
  });
}

describe('release identity', () => {
  it('derives every name from one id and package.json', () => {
    const id = derive('2026.09.29-win-0.2.0-rc.1');
    expect(id).toMatchObject({
      releaseId: '2026.09.29-win-0.2.0-rc.1',
      productVersion: '0.2.0',
      displayVersion: '0.2.0-rc.1',
      windowsVersion: '0.2.0.0',
      publisher: 'Rhymer-Lcy',
      appVerName: '政务工作记录台 0.2.0-rc.1',
      installerName: 'CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe',
      payloadName: 'civic-work-desk-windows-x64-2026.09.29-win-0.2.0-rc.1',
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
      expect(() => derive(spent.releaseId)).toThrow(/release identity refused/);
      expect(() => derive(spent.releaseId, { packageVersion: '0.1.0' })).toThrow(
        /release identity refused/,
      );
    }
    // RC1-RC3 all present, so none of them can slip through a shortened list.
    expect(PUBLISHED.releases.map((r) => r.releaseId)).toEqual([
      '2026.09.24-win-rc1',
      '2026.09.24-win-rc2',
      '2026.09.24-win-rc3',
    ]);
  });

  it('refuses an id whose version is not package.json#version', () => {
    expect(() => derive('2026.09.29-win-0.2.0-rc.2')).toThrow(/package.json#version is 0.2.0-rc.1/);
    expect(() => derive('2026.09.29-win-0.2.0')).toThrow(/package.json#version/);
    expect(() => derive('2026.09.29-0.2.0-rc.1')).toThrow(/YYYY.MM.DD-win-<version>/);
  });

  it('refuses shapes civic-admin would refuse, impossible dates and future dates', () => {
    expect(() => derive('2026.09.29-win-0.2.0-rc.1.')).toThrow(/shape/);
    expect(() => derive('2026.09.29-WIN-0.2.0-rc.1')).toThrow(/shape/);
    expect(() => derive('../2026.09.29-win-0.2.0-rc.1')).toThrow(/shape/);
    expect(() => derive('2026.02.30-win-0.2.0-rc.1')).toThrow(/not a calendar date/);
    expect(() => derive('2026.13.01-win-0.2.0-rc.1')).toThrow(/not a calendar date/);
    expect(() => derive('2026.09.30-win-0.2.0-rc.1')).toThrow(/later than today/);
  });

  it('refuses a display version, tag or id that has already been published', () => {
    const published: PublishedReleases = {
      releases: [
        ...PUBLISHED.releases,
        {
          releaseId: '2026.09.29-win-0.2.0-rc.1',
          tag: 'windows-v0.2.0-rc.1',
          displayVersion: '0.2.0-rc.1',
        },
      ],
    };
    expect(() => derive('2026.09.29-win-0.2.0-rc.1', { published })).toThrow(/already published/);
    // A later date does not make a spent display version new again.
    expect(() => derive('2026.09.29-win-0.2.0-rc.1', { published, today: '2026.10.02' })).toThrow(
      /already published/,
    );
    expect(() => derive('2026.10.01-win-0.2.0-rc.1', { published, today: '2026.10.02' })).toThrow(
      /display version 0.2.0-rc.1 is already published/,
    );
  });

  it('lets an audit examine the published release itself, and nothing else', () => {
    const published: PublishedReleases = {
      releases: [
        ...PUBLISHED.releases,
        {
          releaseId: '2026.09.29-win-0.2.0-rc.1',
          tag: 'windows-v0.2.0-rc.1',
          displayVersion: '0.2.0-rc.1',
        },
      ],
    };
    // The build still refuses it -- and refusing is the default when no purpose is given.
    expect(() => derive('2026.09.29-win-0.2.0-rc.1', { published })).toThrow(/already published/);
    expect(() => derive('2026.09.29-win-0.2.0-rc.1', { published, purpose: 'build' })).toThrow(
      /already published/,
    );
    // An audit of exactly that release is allowed.
    expect(derive('2026.09.29-win-0.2.0-rc.1', { published, purpose: 'audit' }).releaseId).toBe(
      '2026.09.29-win-0.2.0-rc.1',
    );
    // An audit of ANOTHER build claiming the same display version is not: that would be a second rc.1.
    expect(() =>
      derive('2026.10.01-win-0.2.0-rc.1', { published, purpose: 'audit', today: '2026.10.02' }),
    ).toThrow(/display version 0.2.0-rc.1 is already published/);
    // RC3 cannot be audited under this package version at all: its id names a different version.
    expect(() => derive('2026.09.24-win-rc3', { purpose: 'audit' })).toThrow(/package.json/);
    expect(() => derive('2026.09.29-win-0.2.0-rc.1', { purpose: 'deploy' })).toThrow(
      /unknown purpose/,
    );
  });

  it('refuses a publisher that is missing, padded, or the product name', () => {
    for (const publisherDisplayName of ['', ' Rhymer-Lcy', 'CivicWorkDesk', '政务工作记录台']) {
      expect(() =>
        derive('2026.09.29-win-0.2.0-rc.1', {
          identity: { ...IDENTITY, publisherDisplayName },
        }),
      ).toThrow(/publisher/);
    }
  });

  it('reads the repository inputs, and they agree with the policy', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const id = loadReleaseIdentity('.', `2026.09.29-win-${pkg.version}`, '2026.09.29');
    expect(id.displayVersion).toBe(pkg.version);
    expect(id.publisher).toBe('Rhymer-Lcy');
  });

  it('dates in UTC+8, not in the workstation zone', () => {
    // 2026-09-29T20:00:00-04:00 is 2026-09-30T08:00:00+08:00.
    expect(businessDateUtc8(new Date('2026-09-29T20:00:00-04:00'))).toBe('2026.09.30');
    expect(businessDateUtc8(new Date('2026-09-29T11:59:59-04:00'))).toBe('2026.09.29');
  });
});
