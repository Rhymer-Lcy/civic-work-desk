/**
 * The identity of one Windows release, derived once and refused rather than guessed.
 *
 * Every name the Windows build writes -- the release directory, the installer filename, the Add/Remove
 * Programs version, the version resources, VERSION, the tag -- comes from here, so they cannot disagree.
 *
 * ## Why there is no default release id
 *
 * Until Phase 6, build-release.mjs defaulted --release-id to 2026.09.24-win-rc3 and generate-winres.mjs
 * to 2026.09.24-win-rc2. A build run without the flag would have stamped a new payload with an identity
 * that was already published, and nothing downstream would have noticed. So the id is now required,
 * and it is checked against what it claims to be:
 *
 *   - it has the Go deployment's shape (layout.ReleaseIDPattern), or civic-admin could not activate it;
 *   - it is YYYY.MM.DD-win-<displayVersion>, and <displayVersion> is exactly package.json#version, so an
 *     id cannot name one version while the payload carries another;
 *   - its date is a real calendar date, and not later than today in UTC+8 (the business calendar);
 *   - neither the id, nor its display version, nor its tag appears in published-releases.json -- a
 *     published candidate's identity is spent, and a second "0.2.0-rc.1" would make two different
 *     installers answer to one name;
 *   - the id does not appear in rejected-releases.json -- a candidate that was built, frozen and then
 *     rejected before publication has spent its engineering id too, so its bytes can never be confused
 *     with a later build's. Its display version is not spent: it was never published, so the rebuilt
 *     candidate may carry the same public version under a new id.
 *
 * The publisher comes from product-identity.json and never from a literal in a build script: RC1-RC3
 * wrote "CivicWorkDesk" as the publisher, which is the product's own name and nobody's identity.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProductVersion } from './product-version.mjs';

/** Must agree with layout.ReleaseIDPattern in deploy/windows/src/internal/layout. */
export const RELEASE_ID_PATTERN =
  /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9]([a-z0-9.-]{0,29}[a-z0-9])?$/;

/** Today's business date in UTC+8, as YYYY.MM.DD. This workstation's clock runs on US Eastern. */
export function businessDateUtc8(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(shifted.getUTCFullYear())}.${pad(shifted.getUTCMonth() + 1)}.${pad(shifted.getUTCDate())}`;
}

function validCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

/**
 * @param {{
 *   releaseId: unknown,
 *   packageVersion: string,
 *   identity: { productNameZh: string, productNameEn: string, publisherDisplayName: string },
 *   published: { releases: ReadonlyArray<{ releaseId: string, tag: string, displayVersion?: string }> },
 *   rejected: { releases: ReadonlyArray<{ releaseId: string, displayVersion: string, sha256: string,
 *     status: string, reason: string }> },
 *   today: string,
 *   purpose?: 'build' | 'audit',
 * }} input
 *
 * `purpose` decides what a published identity means. For `build` -- the default, so forgetting to pass
 * it fails closed -- every published id, display version and tag is spent and refused. For `audit` the
 * one published entry that IS this release (same id, same display version, same tag) is accepted, so the
 * audits and acceptance suites can still examine a release after it has been published; any other
 * collision is refused as before.
 */
export function deriveReleaseIdentity({
  releaseId,
  packageVersion,
  identity,
  published,
  rejected,
  today,
  purpose = 'build',
}) {
  const fail = (why) => {
    throw new Error(`release identity refused: ${why}`);
  };

  if (typeof releaseId !== 'string' || releaseId === '') {
    fail(
      '--release-id is required and has no default. Pass YYYY.MM.DD-win-<package.json version>, ' +
        'dated with today in UTC+8.',
    );
  }
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    fail(`${JSON.stringify(releaseId)} does not have the shape civic-admin accepts`);
  }

  const version = parseProductVersion(packageVersion);
  const match = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})-win-(.+)$/.exec(releaseId);
  if (!match) fail(`${releaseId} is not YYYY.MM.DD-win-<version>`);
  const [, y, m, d, idVersion] = match;
  if (idVersion !== version.displayVersion) {
    fail(
      `${releaseId} names version ${idVersion}, but package.json#version is ${version.displayVersion}`,
    );
  }
  if (!validCalendarDate(Number(y), Number(m), Number(d))) {
    fail(`${y}.${m}.${d} is not a calendar date`);
  }
  const releaseDate = `${y}.${m}.${d}`;
  if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$/.test(today))
    fail(`today ${JSON.stringify(today)} is malformed`);
  if (releaseDate > today) {
    fail(`${releaseDate} is later than today (${today}, UTC+8)`);
  }

  const publisher = identity.publisherDisplayName;
  if (typeof publisher !== 'string' || publisher.trim() === '' || publisher !== publisher.trim()) {
    fail('product-identity.json#publisherDisplayName is missing or malformed');
  }
  if (publisher === identity.productNameEn || publisher === identity.productNameZh) {
    fail(`the publisher ${JSON.stringify(publisher)} is the product's own name, not a publisher`);
  }

  if (purpose !== 'build' && purpose !== 'audit')
    fail(`unknown purpose ${JSON.stringify(purpose)}`);
  const tagName = `windows-v${version.displayVersion}`;
  // Most specific first: the display version is what a person reads, and the tag is derived from it.
  for (const spent of published.releases) {
    const isThisRelease =
      spent.releaseId === releaseId &&
      spent.displayVersion === version.displayVersion &&
      spent.tag === tagName;
    if (purpose === 'audit' && isThisRelease) continue;
    if (spent.releaseId === releaseId) fail(`${releaseId} is already published as ${spent.tag}`);
    if (spent.displayVersion === version.displayVersion) {
      fail(
        `display version ${version.displayVersion} is already published as ${spent.releaseId}; ` +
          'a new candidate needs a new version (bump package.json)',
      );
    }
    if (spent.tag === tagName) fail(`the tag ${tagName} is already published`);
  }

  // A rejected candidate's id is refused for every purpose: nothing may be built or audited under it.
  // The registry itself is checked first, so a truncated or hand-damaged file fails closed instead of
  // silently refusing nothing.
  if (!rejected || !Array.isArray(rejected.releases)) {
    fail('rejected-releases.json is missing or has no releases list');
  }
  for (const entry of rejected.releases) {
    const complete =
      typeof entry?.releaseId === 'string' &&
      RELEASE_ID_PATTERN.test(entry.releaseId) &&
      typeof entry.displayVersion === 'string' &&
      /^[0-9a-f]{64}$/.test(entry.sha256 ?? '') &&
      entry.status === 'rejected-before-publication' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== '';
    if (!complete) fail(`rejected-releases.json has an incomplete entry: ${JSON.stringify(entry)}`);
    if (entry.releaseId === releaseId) {
      fail(
        `${releaseId} was rejected before publication (SHA-256 ${entry.sha256.slice(0, 12)}...); ` +
          'its engineering id is spent -- build the new candidate under a new id',
      );
    }
  }

  const setupBase = `CivicWorkDesk-Windows-x64-${version.displayVersion}-Setup`;
  return Object.freeze({
    releaseId,
    releaseDate,
    productVersion: version.productVersion,
    displayVersion: version.displayVersion,
    windowsVersion: version.windowsVersion,
    windowsParts: version.windowsParts,
    prerelease: version.prerelease,
    publisher,
    productNameZh: identity.productNameZh,
    productNameEn: identity.productNameEn,
    appVerName: `${identity.productNameZh} ${version.displayVersion}`,
    setupBase,
    installerName: `${setupBase}.exe`,
    payloadName: `civic-work-desk-windows-x64-${releaseId}`,
    tagName,
  });
}

/** Read the three inputs from the repository and derive the identity. */
export function loadReleaseIdentity(
  root,
  releaseId,
  today = businessDateUtc8(),
  purpose = 'build',
) {
  const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
  return deriveReleaseIdentity({
    releaseId,
    packageVersion: read('package.json').version,
    identity: read('product-identity.json'),
    published: read(join('scripts', 'windows', 'published-releases.json')),
    rejected: read(join('scripts', 'windows', 'rejected-releases.json')),
    today,
    purpose,
  });
}
