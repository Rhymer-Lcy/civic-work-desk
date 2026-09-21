# Review packages in this directory — provenance

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
