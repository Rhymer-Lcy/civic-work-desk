# Phase 5.1 — Runtime Update Safety Correction: final sign-off

**Date:** 2026-09-29 (UTC+8). **Branch:** `phase-5.1/runtime-update-safety`, from `main` at
`3b71dbc86607186a80de06a3b852a857786eb5a2`. **Scope:** the shared application only. This is a product
sign-off, not a platform release.

Detail lives in the corrective record, [phase-5.1-runtime-update-safety.md](phase-5.1-runtime-update-safety.md).
This record states what was signed off and on what basis. The Phase-5 sign-off,
[phase-5-final-signoff.md](phase-5-final-signoff.md), is not rewritten; it carries only an addendum
pointing here.

## Heads

| head                            | commit                                     | what it is                                                                   |
| ------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| first review round              | `316535c9fab729a671dc1fe558c0a65752be05f4` | defects A to D corrected and documented; accepted by review but for one gap  |
| final product correction        | `d485457e5f8272a0fe409f9f1aab90d878e7b879` | activation only when no other application window is open                     |
| documentation of the correction | `d1e6ceb04d1534aeb71fe136368840cf0e68441f` | the record's section 10, CHANGELOG, security notes; the final gates ran here |
| sign-off                        | the commit that adds this file             | this record and a README pointer                                             |

**No application code changed after `d485457`.** `d1e6ceb` changed `CHANGELOG.md`,
`docs/phase-5.1-runtime-update-safety.md` and `docs/security.md` only, and this commit adds Markdown only.

## What is signed off

| #   | correction                                                                                      | record |
| --- | ----------------------------------------------------------------------------------------------- | ------ |
| A   | the application bar keeps one coordinate frame with classic scrollbars (`scrollbar-gutter`)     | §2     |
| B   | an activation the product did not make reloads no other tab (defence in depth)                  | §3     |
| C   | a waiting worker reports the open windows of the origin, without URLs                           | §4     |
| D   | a page detects that it runs an older interface generation than the installed program expects    | §5     |
| E   | the product's own 应用更新 activates only when no other application window is open, fail-closed | §10    |

Invariants held: database schema **2**, backup format **3**, product version `0.2.0-dev.0`, the
canonical origin, prompt-based updates, offline operation, the three-level hierarchy. Nothing under
`src/db/`, `src/services/backup/`, `src/domain/`, `deploy/`, `scripts/uos/`, `scripts/windows/` or
`release/` differs from `3b71dbc`.

## Final gates

Run at `d1e6ceb` with a clean tree, sequentially, on the development workstation:

| gate                                                                        | command                  | result                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| format, lint, typecheck, unit and integration, static scan, build           | `npm run verify`         | pass; 39 test files, 554 tests; static scan PASS with 16 rules                                                                   |
| E2E, Chromium desktop and mobile                                            | `npm run test:e2e`       | 184 passed, 0 failed, 0 skipped                                                                                                  |
| E2E, installed Edge (geometry, window awareness, generation, update safety) | `npm run test:e2e:edge`  | 30 passed                                                                                                                        |
| E2E, Firefox and WebKit                                                     | `npm run test:e2e:cross` | 23 passed, 1 skipped                                                                                                             |
| accessibility (axe)                                                         | `npm run test:a11y`      | 16 passed                                                                                                                        |
| deployment copy audit                                                       | `npm run audit:copy`     | PASS                                                                                                                             |
| UOS: shell lint, deployment tests, signed-off archive                       | `npm run verify:uos`     | PASS; deployment tests 138/138; archive checks 56/56 against the signed-off `-5` archive (`969a2a74…`) and its kit (`ac77a6e5…`) |

The skipped test is the WebKit offline-reload test, skipped since `eb4fa43` (2026-09-21) for a
reproduced Playwright WebKit limitation, as at the Phase-5 sign-off. For the archive step, byte-identical
copies of the `-5` archive and its kit were placed in the worktree's ignored `release/` and removed
afterwards; the originals were not written and their digests were the same afterwards.

Before the final run, the update-safety, window-awareness, runtime-generation and scrollbar-geometry
suites ran together in both browsers: 60 passed (30 each), no retries.

## A pre-existing Firefox instability

`cross-browser.spec.ts`, "seeds on first run and stores a record that survives a reload", sometimes
fails in Firefox with an error from Playwright's own context teardown
(`Browser.removeBrowserContext`: `can't access property "_maybeDontRestoreTabs"`), not from an
assertion. It predates Phase 5.1: run ten times, it failed 7 of 10 on unmodified `main` and 0 of 10 on
this branch; over 17 runs on the branch in the first round it failed twice. It did not occur in the
final run. The test was not changed, retried or weakened. It is a test and browser-lifecycle
instability to be looked at on its own.

## Known limits, stated

- **RC3 and earlier pages** send the plain skip-waiting message from their own 应用更新 without asking;
  product code cannot change them. Pages of this generation that such an activation takes over are not
  reloaded and say so. Protecting RC3 pages is the deployment's job (record §8).
- **The residual race.** The decision rests on a snapshot. The product's question and its
  skip-waiting message reached the worker 10 ms apart in Chromium and 2 ms apart in Edge; a window
  opened inside that gap is either counted, opened on the new generation, or told by the
  defence-in-depth notice. A worker-side check-and-activate was evaluated and not adopted (record §10).
- **A window at the legacy `/__civic/platform`** is counted as an application window although, under a
  worker, the interface does not start there; the conservative reading is deliberate.
- **The 360 browser on UOS** has not been tested with any of this; it belongs to that platform's next
  release cycle.

## Unchanged by this phase

No platform artifact was built, tagged or published. The rejected Phase-6 candidate
`CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe` (SHA-256
`4fe9296dbbaf20a85a19d742cfd9a7ae86a2e99c16518ec125718a66fd10eae5`) remains rejected before
publication and unpublished. Phase 6 remains paused; its branch and its worktree's uncommitted records
were not touched. It resumes against the new `main` after this sign-off is accepted.

## Integration

`main` is to be advanced to the head that contains this record by a strict fast-forward (no merge
commit, no squash, no rewritten history, no force push), provided `origin/main` is still
`3b71dbc86607186a80de06a3b852a857786eb5a2`, the base of this branch. The resulting commit hashes are
reported outside this file, which cannot name the commit that contains it. The branch is kept.

## Sign-off

On the evidence above:

**Phase 5.1 — Runtime Update Safety Correction: SIGNED OFF.**
