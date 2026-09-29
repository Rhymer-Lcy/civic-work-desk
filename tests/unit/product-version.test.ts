import { describe, expect, it } from 'vitest';
import { buildVersionResource } from '../../scripts/windows/generate-winres.mjs';
import { parseProductVersion } from '../../scripts/windows/product-version.mjs';

/**
 * The Windows numeric version is derived from the product version, never from the pre-release text.
 *
 * Until the Phase-5 closeout `generate-winres.mjs` split `${version}.0` on dots and took
 * `parseInt(part) || 0` of each piece, so `0.2.0-rc.1` became the PE version 0.2.0.1 and any string at
 * all produced *some* number. These tests pin the policy (docs/versioning-and-publisher.md) and decode
 * the bytes of the version resource the build actually writes.
 */

const TARGET = {
  description: '政务工作记录台',
  internal: 'CivicWorkDesk Launcher',
  original: 'x.exe',
};

const RELEASE = {
  releaseId: '2026.09.29-win-0.2.0-rc.1',
  publisher: 'Rhymer-Lcy',
  productNameZh: '政务工作记录台',
  productNameEn: 'CivicWorkDesk',
};

/** dwFileVersion and dwProductVersion from a VS_VERSION_INFO block, as dotted quads. */
function fixedVersions(resource: Buffer): { file: string; product: string } {
  const signature = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  const at = resource.indexOf(signature);
  expect(at).toBeGreaterThan(0);
  const quad = (ms: number, ls: number): string =>
    [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
  return {
    file: quad(resource.readUInt32LE(at + 8), resource.readUInt32LE(at + 12)),
    product: quad(resource.readUInt32LE(at + 16), resource.readUInt32LE(at + 20)),
  };
}

/** The value of one StringFileInfo entry, e.g. FileVersion. */
function stringValue(resource: Buffer, key: string): string {
  const text = resource.toString('utf16le');
  const start = text.indexOf(`${key}\u0000`);
  expect(start).toBeGreaterThan(0);
  // Key, its terminator, alignment padding (NULs), then the value up to its own terminator.
  let from = start + key.length;
  while (text.charCodeAt(from) === 0) from += 1;
  return text.slice(from, text.indexOf('\u0000', from));
}

describe('parseProductVersion', () => {
  it.each([
    ['0.2.0', '0.2.0', '0.2.0', '0.2.0.0'],
    ['0.2.0-rc.1', '0.2.0', '0.2.0-rc.1', '0.2.0.0'],
    ['0.2.0-beta.7', '0.2.0', '0.2.0-beta.7', '0.2.0.0'],
    ['0.2.0-alpha.12', '0.2.0', '0.2.0-alpha.12', '0.2.0.0'],
    ['0.2.0-dev.0', '0.2.0', '0.2.0-dev.0', '0.2.0.0'],
    ['1.12.3', '1.12.3', '1.12.3', '1.12.3.0'],
    ['65535.0.1', '65535.0.1', '65535.0.1', '65535.0.1.0'],
  ])('%s -> product %s, display %s, Windows %s', (input, product, display, windows) => {
    const version = parseProductVersion(input);
    expect(version.productVersion).toBe(product);
    expect(version.displayVersion).toBe(display);
    expect(version.windowsVersion).toBe(windows);
    expect(version.windowsParts[3]).toBe(0);
  });

  it('keeps the pre-release identifiers, which never reach the numeric version', () => {
    expect(parseProductVersion('0.2.0-rc.1').prerelease).toEqual(['rc', '1']);
    expect(parseProductVersion('0.2.0').prerelease).toEqual([]);
  });

  it.each([
    ['', /empty/],
    [' 0.2.0', /whitespace/],
    ['0.2.0 ', /whitespace/],
    ['v0.2.0', /not a number/],
    ['0.2', /MAJOR\.MINOR\.PATCH/],
    ['0.2.0.1', /fourth Windows field is derived/],
    ['1.2.3.4-rc.1', /fourth Windows field is derived/],
    ['0.2.0.x', /MAJOR\.MINOR\.PATCH/],
    ['00.2.0', /leading zeros/],
    ['0.02.0', /leading zeros/],
    ['0.2.0-', /empty/],
    ['0.2.0-rc..1', /pre-release identifier/],
    ['0.2.0-rc.01', /leading zero/],
    ['0.2.0-rc_1', /pre-release identifier/],
    ['0.2.0+build.5', /build metadata/],
    ['65536.0.0', /max 65535/],
    ['0.2.x', /not a number/],
    ['latest', /MAJOR\.MINOR\.PATCH/],
  ])('rejects %j loudly', (input, reason) => {
    expect(() => parseProductVersion(input)).toThrow(reason);
    expect(() => parseProductVersion(input)).toThrow(/invalid product version/);
  });
});

describe('the version resource the build writes', () => {
  it.each([
    ['0.2.0-rc.1', '0.2.0.0'],
    ['0.2.0-beta.7', '0.2.0.0'],
    ['0.2.0-alpha.12', '0.2.0.0'],
    ['0.2.0', '0.2.0.0'],
    ['1.12.3', '1.12.3.0'],
    ['40000.1.2', '40000.1.2.0'],
  ])('%s is stamped as numeric %s, with the display version kept as text', (input, numeric) => {
    const resource = buildVersionResource(TARGET, parseProductVersion(input), RELEASE);
    expect(fixedVersions(resource)).toEqual({ file: numeric, product: numeric });
    expect(stringValue(resource, 'FileVersion')).toBe(numeric);
    // Exactly the display version, which is also what Add/Remove Programs shows. RC1-RC3 appended the
    // release id here, so the two places named one build differently.
    expect(stringValue(resource, 'ProductVersion')).toBe(input);
    expect(stringValue(resource, 'Comments')).toBe(`release ${RELEASE.releaseId}`);
  });

  it('names the publisher, never the product, as the company', () => {
    const resource = buildVersionResource(TARGET, parseProductVersion('0.2.0-rc.1'), RELEASE);
    expect(stringValue(resource, 'CompanyName')).toBe('Rhymer-Lcy');
    expect(stringValue(resource, 'LegalCopyright')).toBe('© 2026 Rhymer-Lcy. 保留所有权利。');
    expect(stringValue(resource, 'ProductName')).toBe('政务工作记录台 (CivicWorkDesk)');
    expect(resource.toString('utf16le')).not.toMatch(/win-rc[0-9]|\bRC[0-9]\b/);
  });

  it('has no default for any identity field', () => {
    for (const key of Object.keys(RELEASE) as (keyof typeof RELEASE)[]) {
      expect(() =>
        buildVersionResource(TARGET, parseProductVersion('0.2.0-rc.1'), { ...RELEASE, [key]: '' }),
      ).toThrow(new RegExp(`${key} is required`));
    }
  });

  it('the package version of this branch is policy-conformant', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    expect(parseProductVersion(pkg.version).windowsVersion).toBe('0.2.0.0');
  });
});
