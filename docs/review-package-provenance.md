# Review packages in this directory — provenance

## What is in `_review_packages/` after Phase 1.2

| archive                                         | gates                                 | note                                                                                                                         |
| ----------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `...phase-1-20260921-100343-3727a186a9eb.zip`   | all passed                            | **rebuild** of the destroyed Phase-1 archive; fails one verification check because it carries the Phase-1 entry-count defect |
| `...phase-1-1-20260921-102608-1e0c9cbdb2cb.zip` | all passed                            | the Phase-1.1 deliverable                                                                                                    |
| `...phase-1-2-20260921-125349-0cfad5abe07d.zip` | **3 FAILED** (lint, typecheck, build) | superseded; kept rather than deleted — see below                                                                             |
| `...phase-1-2-20260921-130202-092138495b4b.zip` | all passed                            | **the Phase-1.2 deliverable**                                                                                                |

Nothing was deleted during Phase 1.2. The Phase-1.2 instructions forbid deleting any existing archive
or checksum and forbid wildcard deletion in this directory, so the superseded build below stays where it
is rather than being tidied away.

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

The superseded archive is not a deliverable. The Phase-1.2 deliverable is
`...phase-1-2-20260921-130202-092138495b4b.zip`, SHA-256
`145bf05d89c91bc0dfb602c0f21fcef44c06ed4eb1aef2f6ff4cf72cef558c07`, which passes all ten gates and 21/21
verification checks.

### The original Phase-1 archive was not recovered

The Phase-1.2 instructions said the original archive "has been recovered externally and should be
restored to `_review_packages` if available". It was **not available**: a search of `F:\`, the user
profile's Downloads and Desktop, `E:\` and the session scratch directory found no file named
`civic-work-desk-phase-1-20260921-081722-3727a186a9eb.zip` and no archive with digest `7a8654f2…`. The
rebuild described below therefore remains the only Phase-1 artifact present, and nothing was overwritten.

## The original Phase-1 package was deleted, and could not be recovered

`civic-work-desk-phase-1-20260921-081722-3727a186a9eb.zip`, SHA-256
`7a8654f2d49a3b7aa73bfc4a511b9be7702d5617f903cd3da9b417da9b6593ed`, no longer exists.

During Phase 1.1 it was removed by a `rm -f _review_packages/*.zip _review_packages/*.sha256` that
was intended to clear two throwaway test packages built minutes earlier. `rm` from Git Bash does not
use the Windows Recycle Bin, so the bytes are gone; the Recycle Bin was checked and holds nothing
from that day.

**What survives is the content, not the artifact.** The tree that package described is git commit
`3727a186a9eb8a91ebd3195c13a6ae74ed28a31c`, which is intact and is the parent of every Phase-1.1
commit. What is irrecoverable is the packaged evidence: that particular archive, its timestamps, its
captured gate output, and its digest.

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
