# `_private_reference/` — confidential legacy source material

## Why this directory exists

CivicWorkDesk is a rewrite of a single-file HTML prototype ("工作记录台"). That prototype embedded
**real** work records directly in its source. It is confidential material and is excluded from Git,
from production builds, from test fixtures and from every review package.

The original file is kept here — unmodified — for exactly three purposes:

1. **Provenance.** The rewrite must be auditable against the artefact it replaces.
2. **Behavioural reference.** `docs/legacy-audit.md` cites line numbers in this file.
3. **Migration validation.** The import path must accept backups produced by the prototype.

It is kept **out of Git, out of production builds, out of test fixtures, and out of every review
package.** The only thing published about it is non-sensitive structural metadata (filename,
byte size, line count, SHA-256).

## Contents

| File | Tracked in Git | Notes |
| --- | --- | --- |
| `README.md` | yes | this file |
| `work-record-console.original.html` | **no** | the original prototype, byte-identical, read-only |

## Integrity record

The original was renamed from `工作记录台.html` to an English technical filename. Its bytes were
not altered; the hash below was taken before the move and re-verified after it.

| Property | Value |
| --- | --- |
| Original filename | `工作记录台.html` |
| Size | 283,216 bytes |
| Lines (LF) | 3,590 |
| Line endings | LF only (0 CR bytes) |
| Encoding | UTF-8, no BOM |
| SHA-256 | `49833b63e541a79d63ac29ea6c3d34e6a25a92fd82d38f4c0840b0ab679d9cb4` |

The file is marked read-only on disk. Verify it at any time with:

```powershell
Get-FileHash -Algorithm SHA256 _private_reference/work-record-console.original.html
```

## Rules

- **Never** sanitise the original in place. It is immutable evidence.
- **Never** copy records, names, or phone numbers out of it into fixtures, tests, docs, or commits.
  `tests/fixtures/` contains only synthetic data that reproduces the *structural* edge cases
  (see `docs/migration.md`).
- **Never** add it to a review package. `scripts/verify-review-package.mjs` fails the build if any
  path under `_private_reference/` other than this README appears in an archive.
- If the file must leave this machine, treat it as a personal-data transfer and handle it under
  whatever policy governs the source records — not as source code.
