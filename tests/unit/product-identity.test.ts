import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Product identity and version governance (docs/versioning-and-publisher.md).
 *
 * The identity file and `package.json` are read from disk, so a drift between them — a renamed
 * package, a publisher typed differently, a store identity filled in by guesswork — fails here rather
 * than in a store review.
 */

interface ProductIdentity {
  readonly productId: string;
  readonly productNameZh: string;
  readonly productNameEn: string;
  readonly productVersionSource: string;
  readonly publisherDisplayName: string;
  readonly storePublisherIdentity: string | null;
  readonly storePublisherIdentityStatus: string;
  readonly repositoryUrl: string;
  readonly license: string;
}

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly private: boolean;
  readonly homepage: string;
}

const identity = JSON.parse(readFileSync('product-identity.json', 'utf8')) as ProductIdentity;
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson;

/** SemVer 2.0.0, core plus optional pre-release; build metadata is not used here. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

describe('product identity', () => {
  it('names the same product as package.json', () => {
    expect(identity.productId).toBe(pkg.name);
    expect(identity.license).toBe(pkg.license);
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.private).toBe(true);
    expect(pkg.homepage.startsWith(identity.repositoryUrl)).toBe(true);
    expect(identity.productVersionSource).toBe('package.json#version');
  });

  it('uses the repository owner as the provisional publisher, not the product name', () => {
    expect(identity.publisherDisplayName).toBe('Rhymer-Lcy');
    expect(identity.publisherDisplayName).not.toBe(identity.productNameEn);
  });

  it('leaves the store publisher identity unresolved until a verified identity exists', () => {
    expect(identity.storePublisherIdentity).toBeNull();
    expect(identity.storePublisherIdentityStatus.startsWith('unresolved')).toBe(true);
  });
});

describe('product version', () => {
  it('is SemVer, on the 0.2.0 line while Phase 5 is in development', () => {
    const match = SEMVER.exec(pkg.version);
    expect(match, `package.json version ${pkg.version} is not SemVer`).not.toBeNull();
    expect(`${match?.[1] ?? ''}.${match?.[2] ?? ''}.${match?.[3] ?? ''}`).toBe('0.2.0');
    // A development build must say so; a final 0.2.0 is cut only by a release phase.
    expect(match?.[4]).toBe('dev.0');
  });

  it('is not a date-based release id, which belongs to provenance, not to the product', () => {
    expect(pkg.version).not.toMatch(/\d{4}\.\d{2}\.\d{2}/);
    expect(pkg.version).not.toMatch(/win|uos|rc\d/i);
  });
});
