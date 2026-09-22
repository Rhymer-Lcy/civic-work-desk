# Phase-1.3 audit regression evidence

Every claim in this file can be reproduced from material inside the review package. Phase 1.2's final
report cited supplementary verification that was not packaged; the probes, the fixture generator and
the captured output below are all included here so an independent reviewer can re-run or at least
inspect them.

## 1. The primary blocker, demonstrated against Phase 1.2

**Claim.** A normal user workflow left Phase 1.2 in a state where the application produced a canonical
backup it labelled **complete**, recorded it as a successful backup, and then **refused to restore**
that same file.

**Probe.** `scripts/audit/phase-1-2-live-integrity-probe.test.ts` — written against the Phase-1.2 API,
so it runs unchanged on that commit. Each assertion states the Phase-1.3 invariant, so each one fails
there.

**How to reproduce.**

```bash
git worktree add ../p12 48480cf47fc6b9a6f5974de808e39f1576286a46
cd ../p12 && npm ci
cp <package>/scripts/audit/phase-1-2-live-integrity-probe.test.ts tests/integration/zz-probe.test.ts
npx vitest run tests/integration/zz-probe.test.ts
```

**Captured output, commit `48480cf47fc6b9a6f5974de808e39f1576286a46`, 2026-09-21:**

```
 × the honour survives with its reference DETACHED, not dangling 19ms
 × the live state is not treated as backup-viable while a relation dangles 7ms
 × the backup the application produced must be accepted by the same version 8ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: the reference must be detached when the work record is purged:
  expected 'test-id-0001' to be null
AssertionError: the snapshot must contain no unresolved honour reference:
  expected [ { id: 'test-id-0002', …(15) } ] to deeply equal []
AssertionError: a file the application labelled complete must be exact-restorable:
  expected [ Array(1) ] to deeply equal []
  - Expected
  + Received
  - []
  + [
  +   "备份文件的关联关系不自洽，无法精确还原（1 处）：荣誉引用了文件中不存在的工作记录：test-id-0002→test-id-0001",
  + ]

 Test Files  1 failed (1)
      Tests  3 failed (3)
```

The third failure is the contradiction stated in the application's own words: the file was written as
`completeness: "complete"`, and the same build refused it because the honour referenced a work record
the file did not contain.

**At Phase-1.3 HEAD** the maintained version of these assertions —
`tests/integration/live-integrity.test.ts`, written against the current API — passes:

```
 ✓ PRIMARY BLOCKER: purging a work record referenced by an honour
   ✓ leaves no dangling relation, and the resulting backup is exact-restorable 25ms
   ✓ bulk purge detaches every affected honour and stays relationally valid 7ms
   ✓ the purge mutation is atomic and bumps the revision exactly once 6ms
 ✓ a relationally broken live store cannot produce a complete canonical backup
   ✓ REGRESSION: a dangling honour relation blocks a complete backup 4ms
   ✓ REGRESSION: an orphan progress entry blocks a complete backup 3ms
   ✓ REGRESSION: a dangling category or group reference is diagnosed 3ms
   ✓ the diagnostic recovery export carries the structured relational issues 2ms
 ✓ ordinary mutations cannot create a dangling reference
   ✓ refuses a progress entry for a record that does not exist 1ms
   ✓ refuses an honour linked to a nonexistent work record 1ms
   ✓ refuses an honour linked to another honour 2ms
   ✓ refuses a work record with a nonexistent category or group 2ms
   ✓ refuses an edit that would dangle a reference 3ms
   ✓ a soft-deleted work record still satisfies an honour reference 7ms
   ✓ a category still referenced by a soft-deleted record cannot be deleted 2ms
   ✓ deleting a group detaches its members rather than dangling them 3ms
   ✓ group deletion also detaches trashed members, and the UI says so 13ms
   ✓ a complete backup of any reachable live state restores exactly 4ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

The full run is in `review/VERIFY_LOG.txt`, which is captured output from the gates this package's
producer actually executed.

## 2. The Phase-1.2 v3 archive used for the compatibility test

`tests/fixtures/phase-1-2-canonical-v3.json` was **not written by hand**. It was produced by running
`scripts/audit/generate-phase-1-2-fixture.test.ts` inside a worktree at
`48480cf47fc6b9a6f5974de808e39f1576286a46`, and saved with its digest untouched. Hand-writing the
shape would only have proved that this build agrees with itself.

**How to reproduce.**

```bash
git worktree add ../p12 48480cf47fc6b9a6f5974de808e39f1576286a46
cd ../p12 && npm ci
cp <package>/scripts/audit/generate-phase-1-2-fixture.test.ts tests/integration/zz-gen.test.ts
FIXTURE_OUT=/tmp/regen.json npx vitest run tests/integration/zz-gen.test.ts
```

**The regenerated file is not byte-identical to the committed one, and that is expected.** The
repository's Prettier gate covers `.json`, so the generated file was reformatted before it was
committed. Re-run on 2026-09-21 in a fresh worktree, the relationship is exactly:

```
sha256 8bf8b222887478f1a5dfe602eb1eaab4536c0e5e6028c3ed55dbe6bacf411fe9  raw generator output
sha256 364b254e5d110b92cad45b624c4a69c002940afe8d4db15e5c59886d5204bd2a  committed fixture
                                                                        = prettier --write of the raw output, byte for byte
envelope checksum recorded inside both files:
       fcbb6451ba07f5bb6e0b0a4687b38009a042ee94a1da3204a1ad170209d4b552
```

Whitespace lies outside the envelope digest's scope, so the reformatted file still verifies under
its own recorded checksum — which is what the compatibility test checks, and why reformatting it was
safe.

The file: `backupFormatVersion: 3`, `completeness: "complete"`, `checksum.scope: "envelope"`,
2 records (1 work, 1 honour), 1 progress entry, 12 categories, 3 groups, the honour's `relatedWorkId`
pointing at the work record. All content is synthetic — placeholder names, a generic unit, a
`138-0013-xxxx` documentation-block phone number.

`tests/integration/v3-compatibility.test.ts` restores it, merges it, and confirms that a Phase-1.2
archive carrying relational corruption is still refused rather than repaired.

## 3. Where each mandated regression lives

| #   | Requirement                                                      | Test                                                                             |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | hard purge of a linked work record leaves no dangling relation   | `live-integrity` › leaves no dangling relation…                                  |
| 2   | bulk purge with multiple linked honours stays valid              | `live-integrity` › bulk purge detaches every affected honour                     |
| 3   | purge mutation is atomic                                         | `live-integrity` › the purge mutation is atomic…                                 |
| 4   | post-purge backup is complete and exact-restorable               | `live-integrity` › leaves no dangling relation… (steps 6–7)                      |
| 5   | injected dangling honour relation prevents a complete backup     | `live-integrity` › a dangling honour relation blocks…                            |
| 6   | injected orphan progress prevents a complete backup              | `live-integrity` › an orphan progress entry blocks…                              |
| 7   | injected dangling category/group is diagnosed                    | `live-integrity` › a dangling category or group reference…                       |
| 8   | new progress merges into an existing destination record          | `merge-semantics` › a new note for a record the destination already has          |
| 9   | merge progress collision stays non-overwriting                   | `merge-semantics` › a progress id that collides…                                 |
| 10  | merge cannot introduce a dangling category                       | `merge-semantics` › a category that exists in neither…                           |
| 11  | merge cannot introduce a dangling group                          | `merge-semantics` › a group that exists nowhere is refused                       |
| 12  | merge cannot introduce a dangling related-work reference         | `merge-semantics` › an honour pointing at a work record that exists nowhere      |
| 13  | incomplete-archive subset merge cannot create dangling relations | `merge-semantics` › an incomplete archive cannot be merged into a dangling state |
| 14  | all-soft-deleted records do not cause a false `fresh`            | `backup-health-scope` › every record soft-deleted still needs a backup           |
| 15  | settings-only mutation with zero records                         | `backup-health-scope` › a settings-only change…                                  |
| 16  | category/group-only mutation with zero records                   | `backup-health-scope` › a category-only / group-only change…                     |
| 17  | pristine first run keeps the non-nagging behaviour               | `backup-health-scope` › a genuinely pristine first run does not nag              |
| 18  | contradictory v3 completeness rejected despite a valid checksum  | `backup-health-scope` › "complete" with a non-empty omission list…               |
| 19  | all-invalid legacy replace cannot clear the destination          | `backup-health-scope` › an all-invalid legacy source cannot clear…               |
| 20  | a valid Phase-1.2 v3 archive remains compatible                  | `v3-compatibility` (whole file)                                                  |

Test files are under `tests/integration/`.

## 4. The package's own figures, checked from the outside in

`scripts/audit/package-consistency-audit.mjs <path-to-zip>` re-derives every count printed in this
package from `review/VERIFY_LOG.txt` — the one file in it that nobody writes by hand — and then
requires the packaged prose to carry exactly that value, anchored on the whole clause rather than on
the digits. It exists because the standard verifier asks a different question (is the archive well
formed?) and because the failure this one is aimed at is invisible to the other direction: a figure
quoted in two documents and stale in one of them.

It reports 19 checks and can fail. Run against the superseded
`...phase-1-3-20260921-211918-051619f1ee6d.zip` it reports four inconsistencies, three of which are
the real defects that archive shipped with — a captured test listing showing sixteen cases where the
run had seventeen, and a changelog count of 49 where the four suites hold 50. Run against the current
package it reports none. (Auditing any superseded archive also fails the archive-directory checks by
construction, because later archives exist; that is about the passage of time, not about the old
package.)

## 5. What is not claimed

- No real Safari or iOS device was used. Playwright's WebKit is not Safari.
- The WebKit offline **reload** case remains skipped, with the reason recorded in the test
  (`page.reload()` after `context.setOffline(true)` fails with an internal error in Playwright 1.63.0
  / WebKit 26.6). The offline **write** path does run on WebKit.
- The counts in this package come from the run recorded in `review/VERIFY_LOG.txt`. No figure here was
  copied from an earlier phase's log.
