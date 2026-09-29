/**
 * The product version, parsed once and deliberately, for everything the Windows build derives from it.
 *
 * Policy (docs/versioning-and-publisher.md):
 *
 *   package.json#version     0.2.0-rc.1   SemVer: MAJOR.MINOR.PATCH, optional pre-release
 *   productVersion           0.2.0        the SemVer core
 *   displayVersion           0.2.0-rc.1   exactly what package.json says
 *   windowsVersion           0.2.0.0      the PE numeric quad: the core plus a fourth field that is 0
 *
 * The fourth Windows field is always 0. A pre-release ordinal is part of the display version and is
 * never promoted into it: until this module existed, `generate-winres.mjs` split `0.2.0-rc.1.0` on
 * dots and took `parseInt(part) || 0` of each piece, so `0.2.0-rc.1` became 0.2.0.1 — a number that
 * says "build 1 of 0.2.0" when it meant "release candidate 1 of a version not yet released".
 *
 * Anything that is not exactly this grammar is rejected with a message, never repaired:
 *
 *   - build metadata (`+…`) — the policy does not use it;
 *   - a four-part numeric version (`1.2.3.4`) — the fourth field is derived, never supplied;
 *   - leading zeros, empty identifiers, surrounding whitespace, a leading `v`;
 *   - any numeric field above 65535, which a PE version field (16 bits) cannot hold.
 */

const NUMERIC = /^(0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const PE_FIELD_MAX = 65535;

/**
 * @param {string} text
 * @returns {{
 *   major: number, minor: number, patch: number,
 *   prerelease: readonly string[],
 *   productVersion: string, displayVersion: string, windowsVersion: string,
 *   windowsParts: readonly [number, number, number, number]
 * }}
 */
export function parseProductVersion(text) {
  const fail = (why) => {
    throw new Error(`invalid product version ${JSON.stringify(text)}: ${why}`);
  };
  if (typeof text !== 'string' || text === '') fail('it is empty');
  if (text !== text.trim()) fail('it has surrounding whitespace');
  if (text.includes('+')) fail('build metadata (+…) is not part of the versioning policy');

  const dash = text.indexOf('-');
  const core = dash < 0 ? text : text.slice(0, dash);
  const pre = dash < 0 ? null : text.slice(dash + 1);

  const parts = core.split('.');
  if (parts.length === 4 && parts.every((p) => NUMERIC.test(p))) {
    fail(
      'a product version has three numeric parts; the fourth Windows field is derived (always 0)',
    );
  }
  if (parts.length !== 3) fail('the core must be MAJOR.MINOR.PATCH');
  for (const part of parts) {
    if (!NUMERIC.test(part)) fail(`"${part}" is not a number without leading zeros`);
    if (Number(part) > PE_FIELD_MAX)
      fail(`${part} does not fit a Windows version field (max 65535)`);
  }

  /** @type {string[]} */
  const prerelease = [];
  if (pre !== null) {
    if (pre === '') fail('the pre-release part after "-" is empty');
    for (const identifier of pre.split('.')) {
      if (!IDENTIFIER.test(identifier)) fail(`"${identifier}" is not a pre-release identifier`);
      if (/^[0-9]+$/.test(identifier) && !NUMERIC.test(identifier)) {
        fail(`numeric pre-release identifier "${identifier}" has a leading zero`);
      }
      prerelease.push(identifier);
    }
  }

  const [major, minor, patch] = parts.map(Number);
  return {
    major,
    minor,
    patch,
    prerelease,
    productVersion: `${major}.${minor}.${patch}`,
    displayVersion: text,
    windowsVersion: `${major}.${minor}.${patch}.0`,
    windowsParts: [major, minor, patch, 0],
  };
}
