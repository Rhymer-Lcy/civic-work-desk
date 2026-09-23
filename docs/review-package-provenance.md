# Review packages in this directory — provenance

## Phase 3 Stage A: archives produced by gate runs, not releases

Phase 3's review package is created only after Stage B — after the physical UOS workstation has
returned evidence — so the packaging script's `PHASE` constant is deliberately still `2` during
Stage A. Running the full gate set (`npm run review:package`) nevertheless writes an archive each
time, which is how `...phase-2-20260922-054908-7da4c057b226.zip` and
`...phase-2-20260922-055729-da76b48c2c51.zip` came to exist on the Phase-3 branch.

They are gate evidence for Phase-3 Stage-A commits, not Phase-2 releases and not Phase-3 releases.
The Phase-2 deliverable remains `...phase-2-20260922-012109-c51456361487.zip`. The 054908 archive
additionally records two FAILED gates (format, lint), which is accurate: the UOS bundle stages a copy
of `dist/` under `release/uos-rc1/app/`, and Prettier and ESLint were trying to check build output
until that path was excluded.

Kept rather than deleted, per this directory's standing rule.

## What is in `_review_packages/` after Phase 2

Phase 2 deletes nothing. The Phase-1.3.1 deliverable
(`...phase-1-3-1-20260921-232023-94c5744bf645.zip`) remains present and remains the artifact the
data-layer sign-off was given against.

| archive                                                                            | gates                  | note                                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `...phase-1-…`, `...phase-1-1-…`, `...phase-1-2-…`, `...phase-1-3-…`               | see the sections below | history, unchanged                                                                        |
| `...phase-1-3-1-20260921-232023-94c5744bf645.zip`                                  | all passed, 21/21      | **the Phase-1.3.1 deliverable**                                                           |
| `...phase-1-3-1-20260922-005341-1f500ecb85f0.zip`                                  | **skipped**            | not a deliverable — see below                                                             |
| `...phase-1-3-1-20260921-233457-1f500ecb85f0.zip` and any other `--no-gates` build | **skipped**            | same                                                                                      |
| the newest `phase-2-…`                                                             | all passed             | **the Phase-2 deliverable**; it names itself in its own `REVIEW_SUMMARY.md` and `.sha256` |

### The gateless Phase-1.3.1 archive is a measurement artifact, not a release

`...phase-1-3-1-20260922-005341-1f500ecb85f0.zip` was produced during Phase 2 by running the packaging
script with `--no-gates`, to read the bundle sizes of the pre-redesign build for the before/after
comparison. It says so itself: its `review/VERIFY_LOG.txt` contains a single line,
`Gates were SKIPPED for this package (--no-gates).`, and its `REVIEW_SUMMARY.md` still carries the
Phase-1.3.1 heading because the phase constant had not yet been bumped.

Using the packaging script to take a measurement was a poor choice — a build script that writes into
the deliverables directory should not be used as a ruler, and `dist/` could have been measured
directly. It is kept rather than deleted, because this directory's rule is that archives are never
removed, and it is described here so that a reviewer who finds a gateless archive with a stale phase
label does not have to guess what it is. **It is not a release and must not be reviewed as one.**

## What is in `_review_packages/` after Phase 1.3.1

Phase 1.3.1 adds its own archive and deletes nothing. The Phase-1.3 deliverable
(`...phase-1-3-20260921-214120-e9547922ea70.zip`, all gates passed, 21/21 verified, 19/19 consistency
audit) remains present and remains the artifact the Phase-1.3 review signed off; it is superseded as a
_release_ by the newest `phase-1-3-1-…` archive, not withdrawn as evidence.

| archive                                           | gates                | note                                                                      |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `...phase-1-3-…` (eight of them)                  | see below            | Phase-1.3 history, unchanged; the 214120 build is its deliverable         |
| `...phase-1-3-1-20260921-225343-37ab449ec756.zip` | all passed           | superseded; see below                                                     |
| `...phase-1-3-1-20260921-230015-a7d4db67c162.zip` | all passed           | superseded; its provenance table did not yet list the 225343 build        |
| `...phase-1-3-1-20260921-230419-3f0588d476bd.zip` | **1 FAILED** (cross) | one intermittent WebKit failure, described below and in `docs/qa-plan.md` |
| the newest `phase-1-3-1-…`                        | all passed           | **the Phase-1.3.1 deliverable**; it names itself in its own summary       |

The **230419** build is the only Phase-1.3.1 archive with a failing gate, and the failure is not a code
defect that was then fixed. Its cross-engine gate hit a **single intermittent WebKit failure** in the
linked-honour purge flow, on code identical to the two builds that passed immediately before it (the
only change between them was one documentation paragraph). The symptom is captured in its own
`VERIFY_LOG.txt`: after `locator.fill('清空')` the confirm button stayed disabled and the click retried
to the timeout. Five further runs passed. **The mechanism was not identified**, two plausible causes
were checked and ruled out, and no production code was changed on its account; what changed is that the
cross-engine suite now types real key events and asserts the phrase gate opened before clicking through
it. `docs/qa-plan.md` records exactly what that does and does not establish.

The **225343** build passed all ten gates and 21/21 verification, and was superseded for one reason: the
copy of `scripts/audit/package-consistency-audit.mjs` inside it still carried a check that counted ✓
marks across the whole evidence document against a single suite's total. That was correct while the
document held one captured listing and became meaningless when Phase 1.3.1 added a second — it read 32
for a 17-case suite, which is how it was found. Anchoring each count to its own fenced block fixed it,
and exposed a second bug in the same few lines (a fence regex missing the optional language tag, which
paired one block's closing fence with the next one's opening fence). Both are described in that
script's own header. The packaged evidence has to be the version that was actually run, so the package
was rebuilt rather than annotated.

## What is in `_review_packages/` after Phase 1.3

| archive                                         | gates                      | note                                                                                        |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `...phase-1-3-20260921-144946-1a9fb1fb05f0.zip` | **1 FAILED** (static scan) | superseded; the failure and its fix are described below                                     |
| `...phase-1-3-20260921-150025-4f69c8b286b2.zip` | all passed, 21/21          | superseded; its `REVIEW_SUMMARY.md` stated gate results but not the counts                  |
| `...phase-1-3-20260921-151003-7d59b82221b0.zip` | all passed, 21/21          | superseded by this section being added to the packaged docs                                 |
| `...phase-1-3-20260921-151747-1167c0131e9b.zip` | all passed, 21/21          | superseded by the taxonomy-disclosure fix found while defending the invariants              |
| `...phase-1-3-20260921-153012-nogit.zip`        | **2 FAILED**, interrupted  | not a deliverable and names no commit; kept rather than deleted — see below                 |
| `...phase-1-3-20260921-211918-051619f1ee6d.zip` | all passed, 21/21          | superseded; it carried that fix but its evidence doc still showed the pre-fix test listing  |
| `...phase-1-3-20260921-212545-eafb8dd327a1.zip` | all passed, 21/21          | superseded by this row and the one above it                                                 |
| `...phase-1-3-20260921-213415-c1229ce55cab.zip` | all passed, 21/21          | superseded; the outside-in consistency audit was added to the packaged evidence after it    |
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

The **153012-nogit** archive is the odd one, and it is recorded here precisely because an unexplained
archive carrying FAIL lines is what a sign-off review should not have to guess about. Its own metadata
says what it is: `git` was unavailable to the packaging script, so it names **no commit and no branch**
and its working-tree line reads "not clean" for want of an answer; its log shows the accessibility run
stopping after two failures at 24 ms and 0 ms with four later tests never started, and `npm audit`
exiting `3221225794` (`0xC0000142`, a Windows "application failed to initialize"). That is the
signature of a run whose environment went away underneath it, not of a repository in a bad state — the
same gates pass on either side of it, and it was built during an interrupted packaging invocation. It
is not a deliverable, it describes no commit, and nothing in it should be read as evidence about the
code. It was kept because this directory's rule is that archives are never deleted.

The **211918** build carried that fix, and every gate and count in it is accurate — but the captured
test listing in `docs/audit-regression-results.md` was still the sixteen-test run from before it, and
a captured block that no longer matches the run it claims to show is worth a rebuild rather than a
footnote. That listing and the changelog's test count were re-captured.

The **212545** build is superseded only by this section: it was produced before the two archives above
were described here.

The **213415** build is superseded by the addition of
`scripts/audit/package-consistency-audit.mjs`: the final report claims an independent consistency
audit of this package, and §18 of the Phase-1.3 instructions requires such a claim to be
reproducible from packaged material rather than merely asserted. That audit found nothing wrong with
213415 — it passed all nineteen of its checks — so the rebuild adds evidence rather than fixing a
defect.

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

## Stage-B gate runs (2026-09-23, UTC+8)

Two archives were produced while implementing Phase 3 Stage B. Both are kept. Neither is the final
engineering review deliverable — that is cut only after the installed form passes physical-target
acceptance.

### `civic-work-desk-phase-2-20260922-234541-4630ea93bf4f.zip`

digest `1b0c0a61aa1cf8b10ad66a04fcbd343b21cb59c05da2e042a9a9fa1d91650e5b`

**Three gates failed in this run: format, lint, scan.** It is retained precisely because it failed,
and because each failure is worth keeping on the record rather than tidying away:

- `format` — four files written earlier in the session had not been through Prettier;
- `lint` — an `eslint-disable` for `no-bitwise` in `archive-tests.mjs` that the configured rule set
  does not need, reported as an unused directive under `--max-warnings=0`;
- `scan` — `absolute-local-path` on a hard-coded developer path inside a **comment** in
  `run-deployment-tests.mjs`. The rule is blunt on purpose and was right to fire: a scan that made an
  exception for comments would stop catching the real thing. The comment was rewritten without a
  concrete path.

All three were fixed and re-verified individually before the next run. The filename carries commit
`4630ea93bf4f` because that was HEAD at build time; the Stage-B work was not yet committed.

### The clean Stage-B run

Recorded in the section appended below once produced. The gate archive is a record of a gate run over
a tree, so its own provenance entry is necessarily written after it exists — the archive does not
contain the paragraph describing it. That has been true of every entry in this file.

### An incidental result worth keeping: the build is reproducible

The end-user release archive was staged from the `dist/` present before the gate run. The gate run's
own `npm run build` replaced `dist/`, and `npm run test:uos:archive` — which compares the archive's
`app/` members against `dist/` by digest, from inside the tar — still reported all 23 application
files byte-identical afterwards. So the two builds agree byte for byte, and the release artifact did
not need rebuilding. Stated as the measurement it is: two builds of one commit on one machine, not a
general determinism claim.

### The clean Stage-B run

`civic-work-desk-phase-2-20260923-002800-792c604125a2.zip`

digest `d10c8b4c0c43ee03c68d72a6b73960e49312c5281b95eff93cf03a0aeba68b2f`

All ten gates passed. `verify-review-package.mjs` reports 21/21 and the consistency audit passes, with
30 archives and 30 checksums present in `_review_packages/`.

### Four archives from this session, and why each exists

Kept in full, because a gate archive that failed is evidence about the run, not litter.

| archive (time) | outcome                       | why                                                                      |
| -------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `…-234541-…`   | FAIL format, lint, scan       | unformatted files, an unused eslint-disable, a dev path in a comment     |
| `…-001335-…`   | FAIL e2e, cross               | **contaminated** — two gate runs overlapped, see below                   |
| `…-001756-…`   | FAIL e2e, cross, a11y in 0.6s | **contaminated** — the same overlap, failing instantly on the bound port |
| `…-002025-…`   | FAIL e2e (136s)               | a real run whose e2e failure did not reproduce, see below                |
| `…-002800-…`   | PASS, all ten                 | the clean run of record                                                  |

**Two of those failures are mine, not the code's.** I launched a second `review:package` while the
first was still running. Playwright's preview server binds 127.0.0.1:4173 with
`reuseExistingServer: false` — set in Phase 1.1 precisely so a stale server cannot be silently reused —
so the second run's three browser gates died in under a second rather than testing the wrong build.
That is the configuration working as intended; the lesson is about sequencing gate runs, not about the
suite. Neither archive's e2e result means anything and neither should be cited.

**The `…-002025-…` e2e failure is unexplained and did not reproduce.** It ran 136 s, so tests really
executed. Between that run and the next, `npm run test:e2e` standalone passed **96/96** on the same
`dist/`, and the immediately following `review:package` passed all ten gates including e2e at 126 s.
The packager truncates captured gate output, so the log does not name the failing test — meaning the
cause is not established, and calling it "flaky" is a description of the observation, not a diagnosis.
Recorded rather than dismissed: if e2e fails again inside the packager, the first thing to fix is the
output truncation, so the next occurrence names itself.
