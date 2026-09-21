# Review packages in this directory — provenance

## What is in `_review_packages/` after Phase 1.3

| archive                                         | gates                      | note                                                                                        |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `...phase-1-3-20260921-144946-1a9fb1fb05f0.zip` | **1 FAILED** (static scan) | superseded; the failure and its fix are described below                                     |
| `...phase-1-3-20260921-150025-4f69c8b286b2.zip` | all passed, 21/21          | superseded; its `REVIEW_SUMMARY.md` stated gate results but not the counts                  |
| `...phase-1-3-20260921-151003-7d59b82221b0.zip` | all passed, 21/21          | superseded by this section being added to the packaged docs                                 |
| `...phase-1-3-20260921-151747-1167c0131e9b.zip` | all passed, 21/21          | superseded by the taxonomy-disclosure fix found while defending the invariants              |
| the newest `phase-1-3-…` archive                | all passed                 | **the Phase-1.3 deliverable**; it names itself in its own `REVIEW_SUMMARY.md` and `.sha256` |

Nothing was deleted or renamed during Phase 1.3 either. Every archive and `.sha256` listed in this
document is still present.

### The superseded Phase-1.3 builds, and why each was replaced

The **144946** build failed the static security scan, and the finding was real rather than a false
positive: `scripts/audit/generate-phase-1-2-fixture.test.ts` — packaged as audit evidence for the
first time in this phase — hard-coded `F:/CivicWorkDesk/...` as the destination it wrote the fixture
to. The scan's `absolute-local-path` rule exists to keep a developer's filesystem out of a
deliverable, and it caught exactly that. The generator now takes its destination from `FIXTURE_OUT`,
defaulting to a repository-relative path, and the fixture was regenerated in a fresh worktree at the
Phase-1.2 commit to confirm the parameterised script still reproduces it (see
`docs/audit-regression-results.md` §2).

The **150025** build passed every gate, but its `REVIEW_SUMMARY.md` recorded only PASS per gate — not
the actual test totals, which the Phase-1.3 instructions require the review metadata to state
explicitly. A summary that says PASS and nothing else is the one place a stale count could hide, so
the totals are now parsed from the same captured run rather than typed.

The **151003** build is superseded only by this section: it was produced before the provenance
document described the Phase-1.3 archives, and a packaged document that is stale about its own
directory is the defect this file exists to prevent.

The **151747** build was superseded by a defect found while defending the four final invariants
rather than by any gate. Enumerating every mutation path showed the settings list counts **live**
records while `deleteCategoryIfUnused` and `deleteGroup` count every row a trashed record included —
so a category used only by trashed records offered a delete the database then refused without saying
why, and deleting a group detached trashed members with no confirmation at all. No data was ever at
risk and no invariant was broken; what was broken was the disclosure the hard-delete policy requires.
Fixed in `src/features/settings/taxonomy-copy.ts` and pinned by a test.

## What was in `_review_packages/` after Phase 1.2

| archive                                         | gates                                 | note                                                                                                                         |
| ----------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `...phase-1-20260921-100343-3727a186a9eb.zip`   | all passed                            | **rebuild** of the destroyed Phase-1 archive; fails one verification check because it carries the Phase-1 entry-count defect |
| `...phase-1-1-20260921-102608-1e0c9cbdb2cb.zip` | all passed                            | the Phase-1.1 deliverable                                                                                                    |
| `...phase-1-2-20260921-125349-0cfad5abe07d.zip` | **3 FAILED** (lint, typecheck, build) | superseded; kept rather than deleted — see below                                                                             |
| the newest `phase-1-2-…` archive                | all passed                            | **the Phase-1.2 deliverable**; it names itself in its own `review/REVIEW_SUMMARY.md` and `.sha256`                           |

Nothing was deleted during Phase 1.2. The Phase-1.2 instructions forbid deleting any existing archive
or checksum and forbid wildcard deletion in this directory, so the superseded build below stays where it
is rather than being tidied away. Phase 1.3 inherited the same rule and kept every one of them.

### The superseded Phase-1.2 build, and why it failed

`...phase-1-2-20260921-125349-0cfad5abe07d.zip` was produced before three gates were green and records
that honestly in its own `VERIFY_LOG.txt`: lint, typecheck and build failed. The cause was narrow and
worth recording, because it is a class of mistake that only a full-gate run catches.

`npx tsc -p tsconfig.json --noEmit` — which is what I had been running while iterating — covers the
**application** project only. The repository has a second project, `tsconfig.node.json`, which covers the
Playwright specs and the build scripts, and `npm run typecheck` runs both. A new end-to-end test declared
`async ({ page }, testInfo)` and never used `testInfo`; only the second project saw it. Lint then flagged
four `no-confusing-void-expression` violations in the same test's IndexedDB callbacks, and `npm run build`
fails because it runs `typecheck` first.

The lesson is mechanical: **run `npm run typecheck`, not `tsc -p tsconfig.json`**, before believing a
change typechecks.

The superseded archive is not a deliverable. The Phase-1.2 deliverable is the **newest** `phase-1-2-…`
archive in this directory: it passes all ten gates and 21/21 verification checks, and it identifies
itself in its own `review/REVIEW_SUMMARY.md` and adjacent `.sha256`.

This document deliberately does not quote that archive's digest. It is packaged _inside_ it, and a file
cannot state the checksum of the container it is part of — writing one would guarantee a stale number.
`node scripts/verify-review-package.mjs` computes it from the bytes instead.

### The original Phase-1 archive was restored by the user, and verified

At the start of Phase 1.3 the original archive was present in `_review_packages/`, restored from outside
this workspace. It was verified rather than assumed:

```
file            : civic-work-desk-phase-1-20260921-081722-3727a186a9eb(2).zip
size            : 2205995 bytes
computed sha-256: 7a8654f2d49a3b7aa73bfc4a511b9be7702d5617f903cd3da9b417da9b6593ed
recorded sha-256: 7a8654f2d49a3b7aa73bfc4a511b9be7702d5617f903cd3da9b417da9b6593ed
BYTE-IDENTICAL  : True
```

It is the genuine original, byte for byte. Its filename carries a `(2)` suffix from the download, while
its `.sha256` names the un-suffixed original; both files were left exactly as restored — Phase 1.3
renamed, moved and deleted nothing in this directory. The rebuild from the same commit
(`...100343-3727a186a9eb.zip`) is also still present, and the section below explaining why it exists is
retained as history.

### The earlier statement about it (superseded)

### The original Phase-1 archive was not recovered

The Phase-1.2 instructions said the original archive "has been recovered externally and should be
restored to `_review_packages` if available". It was **not available**: a search of `F:\`, the user
profile's Downloads and Desktop, `E:\` and the session scratch directory found no file named
`civic-work-desk-phase-1-20260921-081722-3727a186a9eb.zip` and no archive with digest `7a8654f2…`. The
rebuild described below therefore remains the only Phase-1 artifact present, and nothing was overwritten.

## How the original Phase-1 package was lost from this workspace

Superseded as to its conclusion — the user restored the file from outside this workspace and it was
verified byte-identical, as recorded above. The account of the loss is kept because it explains why a
rebuild exists beside the original, and because the mistake is worth not repeating.

`civic-work-desk-phase-1-20260921-081722-3727a186a9eb.zip`, SHA-256
`7a8654f2d49a3b7aa73bfc4a511b9be7702d5617f903cd3da9b417da9b6593ed`.

During Phase 1.1 it was removed by a `rm -f _review_packages/*.zip _review_packages/*.sha256` that
was intended to clear two throwaway test packages built minutes earlier. `rm` from Git Bash does not
use the Windows Recycle Bin, so the bytes were gone from this machine; the Recycle Bin was checked
and held nothing from that day. Every later phase has been forbidden to use wildcard deletion here,
and none has deleted anything.

**What survived locally was the content, not the artifact.** The tree that package described is git
commit `3727a186a9eb8a91ebd3195c13a6ae74ed28a31c`, which is intact and is the parent of every
Phase-1.1 commit. What no local copy could reconstruct was the packaged evidence: that particular
archive, its timestamps, its captured gate output, and its digest — which is why the user's restored
copy was verified against the recorded digest rather than merely accepted.

## The Phase-1 archive here is a rebuild, not the original

`civic-work-desk-phase-1-20260921-100343-3727a186a9eb.zip`, SHA-256
`79be0763c42752e6d0d829cea4f7ccff834d51484b544571a2552396ec1822bb`.

Produced by checking out `3727a186a9eb` into a separate git worktree, running `npm ci` against that
commit's `package-lock.json`, and running `node scripts/create-review-package.mjs` — the Phase-1
packaging script, unmodified — with all nine gates. Every gate passed.

It is **not** byte-identical to the original and cannot be: the filename carries the build time, and
`VERIFY_LOG.txt` captures per-gate durations, timestamps and `git status` from the machine at build
time. Treat it as a faithful reconstruction of the Phase-1 deliverable, with a different digest.

One earlier rebuild attempt was discarded: its end-to-end gate attached itself to a `vite preview`
server left running from the Phase-1.1 working tree, so Phase-1 tests ran against the Phase-1.1
build and two failed for reasons unrelated to the code under test. `playwright.config.ts` in Phase
1.1 now sets `reuseExistingServer: false` precisely so that cannot happen again.

## The rebuilt Phase-1 package fails one verification check, correctly

`node scripts/verify-review-package.mjs <phase-1 zip>` reports 20/21, with:

```
FAIL  REVIEW_SUMMARY.md entry count matches the archive: summary says 228, archive holds 229
```

That is the Phase-1 defect the audit found, reproduced on demand. The Phase-1 producer computed the
entry count before appending `REVIEW_SUMMARY.md` and `SHA256SUMS.txt` and compensated with `+1` where
`+2` was needed, so every Phase-1 package understated its own contents by one. The check that reports
it is new in Phase 1.1 — Phase 1 had no check comparing the stated count with the archive, which is
why the discrepancy shipped unnoticed.

The Phase-1 archive is left exactly as its own tooling produced it. It is the historical artifact;
correcting it would misrepresent what Phase 1 was.
