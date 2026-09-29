# Versioning and publisher identity

**Date:** 2026-09-29 (UTC+8). **Status:** policy for the next platform package; nothing here rebuilds or
changes a published artifact. Windows RC3 and UOS `-5` keep the identifiers they shipped with.

## Why this exists

The Windows RC3 installer shows, in Settings → Apps and in Programs and Features:

- **Version** `2026.09.24-win-rc3` — because `deploy/windows/installer/civic-work-desk.iss` sets
  `AppVersion={#CivicReleaseId}`, and Inno Setup documents `AppVersion` as the value "displayed in the
  Version field of the application's Add/Remove Programs entry";
- **Publisher** `CivicWorkDesk` — because the same file defines `CivicPublisher` as the product name and
  sets `AppPublisher={#CivicPublisher}`.

The first mixes a release's provenance into the product's version; the second names the product as its
own publisher. The Go binaries' version resource (`scripts/windows/generate-winres.mjs`) repeats both:
`CompanyName` is `CivicWorkDesk`, `FileVersion` is `${appVersion}.0` and `ProductVersion` is
`${appVersion} (${releaseId})`.

## Six version concepts, kept apart

| concept                   | what it identifies                            | format                          | single source                        | now           |
| ------------------------- | --------------------------------------------- | ------------------------------- | ------------------------------------ | ------------- |
| **productVersion**        | the product's capabilities and compatibility  | SemVer `MAJOR.MINOR.PATCH`      | `package.json#version` (its core)    | 0.2.0 line    |
| **displayVersion**        | what a person sees for a given build          | SemVer with pre-release         | `package.json#version`               | `0.2.0-dev.0` |
| **windowsFileVersion**    | the PE file-version quad Windows requires     | `a.b.c.d`, numbers only         | derived: `MAJOR.MINOR.PATCH.0`       | `0.2.0.0`     |
| **releaseId**             | one engineering build of one platform package | `YYYY.MM.DD-<platform>-<label>` | the release build scripts            | —             |
| **databaseSchemaVersion** | the IndexedDB record shape                    | integer                         | `SCHEMA_VERSION`, `src/db/schema.ts` | **2**         |
| **backupFormatVersion**   | the canonical JSON envelope layout            | integer                         | `BACKUP_FORMAT_VERSION`              | 3 (unchanged) |

Rules that follow:

1. **A product version never contains a date, a platform or a build label.** Those belong to the
   `releaseId`, which lives in `VERSION`, diagnostics, provenance records and release notes — not in the
   Control Panel's Version column.
2. **The pre-release part says how finished it is.** `0.2.0-dev.0` while in development; a field
   candidate is `0.2.0-rc.1`, `-rc.2`, …; a final release is `0.2.0`. SemVer precedence orders them
   correctly (`dev` < `rc` < final).
3. **Why 0.2.0.** Phase 5 adds a feature (the task hierarchy) and changes the stored record shape (schema
   1 → 2) while staying able to read every older archive — a MINOR increment under 0.x.
4. **The numeric Windows version cannot tell two candidates apart** (`0.2.0-rc.1` and `-rc.2` both map to
   `0.2.0.0`). That is acceptable for an Inno Setup installer, where the displayed version is the text
   `AppVersion`. If an MSIX package is ever produced, its `Identity/Version` quad must increase with every
   submission, and the fourth field then becomes a build counter.
5. **The schema version moves only with a Dexie `version(n)` block** and is announced in the backup
   envelope; the backup format moves only when the envelope itself changes. Phase 5 changed the first and
   not the second (docs/phase-5-product-evolution.md §10.2).
6. **Every derived version comes from one fail-closed parser**, `scripts/windows/product-version.mjs`.
   It accepts exactly `MAJOR.MINOR.PATCH` with an optional SemVer pre-release, each numeric field at most
   65535 (a PE version field is 16 bits), and derives `windowsFileVersion` as `MAJOR.MINOR.PATCH.0`. It
   rejects, with the reason, rather than repairs: build metadata (`+…`), a four-part numeric version
   (`1.2.3.4` — the fourth Windows field is derived, never supplied), leading zeros, empty identifiers,
   surrounding whitespace and anything else. Examples, all pinned in `tests/unit/product-version.test.ts`
   against the bytes of the version resource the build writes:

   | package.json#version | displayVersion   | windowsFileVersion |
   | -------------------- | ---------------- | ------------------ |
   | `0.2.0`              | `0.2.0`          | `0.2.0.0`          |
   | `0.2.0-rc.1`         | `0.2.0-rc.1`     | `0.2.0.0`          |
   | `0.2.0-beta.7`       | `0.2.0-beta.7`   | `0.2.0.0`          |
   | `0.2.0-alpha.12`     | `0.2.0-alpha.12` | `0.2.0.0`          |
   | `1.12.3`             | `1.12.3`         | `1.12.3.0`         |
   | `0.2.0.1`, `v0.2.0`  | rejected         | rejected           |

## Publisher identity

| field                  | value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| publisher display name | **Rhymer-Lcy** — the repository owner, for community builds |
| StorePublisherIdentity | **unresolved** (`null` in `product-identity.json`)          |

`Rhymer-Lcy` is provisional and describes only builds published from the GitHub repository. No company is
invented. `StorePublisherIdentity` stays empty until the developer, store and code-signing identities of a
storefront are actually known, because every store binds the publisher to a verified identity:

- **Microsoft Store.** An EXE/MSI listing needs every PE file signed with a certificate chaining to the
  Microsoft Trusted Root Program; the Partner Center publisher display name is effectively permanent, an
  Individual account cannot become a Company account, and a Company account is required when a
  reasonable consumer would read the publisher or app name as a business. For MSIX, `Identity/Publisher`
  must equal the signing certificate's subject. Align `AppPublisher`, the certificate subject and the
  Partner Center display name before the first submission. (Sources and verification labels:
  docs/windows-10-legacy-compatibility.md, "Microsoft Store boundary".)
- **UnionTech store.** Developer real-name verification — an individual's PRC identity card or a company's
  unified social credit code — and, for a company, the full legal name as publisher
  (docs/uos-store-readiness.md).
- **AppGallery Connect.** An individual or enterprise developer account with real-name verification
  (docs/harmonyos-feasibility.md).

`product-identity.json` holds these fields in one place, and `tests/unit/product-identity.test.ts` fails
if it drifts from `package.json`, if the publisher collapses back into the product name, or if a store
identity is filled in.

## What the next packaging phase must change

The numeric-version rows were corrected in the Phase-5 closeout, because they were build-tool defects
rather than packaging decisions (below). Nothing was built: no installer and no version resource was
produced. The remaining rows are release engineering and are left for the next packaging phase, which
starts from this specification.

| where                                           | before the closeout                 | now / must become                                             |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| `civic-work-desk.iss` `AppVersion`              | `{#CivicReleaseId}`                 | must become the displayVersion, e.g. `0.2.0-rc.1`             |
| `civic-work-desk.iss` `AppVerName`              | name + releaseId                    | must become name + displayVersion                             |
| `civic-work-desk.iss` `AppPublisher`            | `CivicWorkDesk`                     | must become `Rhymer-Lcy` (community) or the verified identity |
| `civic-work-desk.iss` `VersionInfoVersion`      | `package.json#version` passed as is | **done:** windowsFileVersion from the parser, e.g. `0.2.0.0`  |
| `civic-work-desk.iss` `#ifndef CivicAppVersion` | fell back to `"0.1.0"`              | **done:** `#error`, like the other required defines           |
| `generate-winres.mjs` `FileVersion` and binary  | `${appVersion}.0`, `parseInt` split | **done:** windowsFileVersion from the parser                  |
| `generate-winres.mjs` `CompanyName`, copyright  | `CivicWorkDesk`                     | must become the publisher display name                        |
| `generate-winres.mjs` `ProductVersion`          | `${appVersion} (${releaseId})`      | displayVersion (releaseId); must drop the releaseId later     |
| `scripts/uos/build-release.sh`                  | copies `package.json#version`       | unchanged; it already records `releaseId` apart               |

**The defect the closeout removed, as measured.** `generate-winres.mjs` built its binary version by
splitting `${appVersion}.0` on dots and taking `parseInt(part) || 0` of the first four parts, so it never
rejected anything: `0.2.0-dev.0` became the binary version `0.2.0.0` with the text `FileVersion`
`0.2.0-dev.0.0`, and `0.2.0-rc.1` became `0.2.0.1` — the candidate number leaking into the fourth field —
with the text `0.2.0-rc.1.0`. `build-release.mjs` passed the same unparsed string to Inno Setup's
`VersionInfoVersion`, which takes up to four dot-separated numbers. Both now take the parser's
windowsFileVersion, and a malformed version stops either script before it writes anything.

Windows Control Panel should then show `0.2.0-rc.1` as Version and the publisher display name as
Publisher; the `releaseId` remains visible in `VERSION`, `civic-diag` output, the provenance record and
the release notes.
