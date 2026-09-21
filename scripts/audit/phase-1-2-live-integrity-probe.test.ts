import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  listRecords,
  purgeRecord,
  softDeleteRecord,
} from '@/db/repositories/records';
import { getMeta } from '@/db/repositories/taxonomy';
import { readStoreSnapshot } from '@/db/snapshot';
import { ABSENT_DATE } from '@/domain/dates';
import { isHonorRecord } from '@/domain/types';
import { createBackup, readBackupSnapshot } from '@/services/backup';
import { buildImportPlan, planBlockers } from '@/services/import/plan';

/**
 * Phase-1.2 live-integrity probe — the Phase-1.3 primary blocker, expressed against the Phase-1.2 API.
 *
 * ## What it proves
 *
 * A normal user workflow — link an honour to a work record, then permanently delete that work record
 * from the Trash — leaves Phase 1.2 in a state where:
 *
 *   - every stored row is individually schema-valid;
 *   - a canonical backup of that state is labelled **complete** and recorded as a successful backup;
 *   - restoring that same file is **refused** for a dangling `relatedWorkId`.
 *
 * The application therefore produces an archive it will not accept. Each assertion below states the
 * Phase-1.3 invariant, so **every one of them fails on Phase-1.2** and passes at Phase-1.3 HEAD.
 *
 * ## How to run it against the Phase-1.2 commit
 *
 * ```bash
 * git worktree add ../p12 48480cf47fc6b9a6f5974de808e39f1576286a46
 * cd ../p12 && npm ci
 * cp <this file> tests/integration/zz-probe.test.ts
 * npx vitest run tests/integration/zz-probe.test.ts     # expect: 3 failed
 * ```
 *
 * At Phase-1.3 HEAD the same file passes — `tests/integration/live-integrity.test.ts` is the
 * maintained version of these assertions, written against the current API.
 *
 * Captured output from both runs: `review/AUDIT_REGRESSION_RESULTS.md` in the Phase-1.3 package.
 *
 * This file lives under `scripts/audit/` rather than `tests/` on purpose: it is audit evidence, not
 * part of the suite, and `vitest.config.ts` only collects `tests/unit` and `tests/integration`.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`p12-live-probe-${String(counter)}`);
  await db.open();
  await ensureSeedData(db);
  setDatabase(db);
});

afterEach(async () => {
  setDatabase(null);
  await db.delete();
});

function workInput(overrides: Record<string, unknown> = {}) {
  return {
    title: '示范工作事项',
    occurredOn: { kind: 'plain', date: '2026-09-01' } as const,
    status: 'todo' as const,
    statusLabel: '',
    requirement: '',
    reportDeadline: ABSENT_DATE,
    completionDeadline: ABSENT_DATE,
    completedOn: ABSENT_DATE,
    categoryId: null,
    groupId: null,
    longTerm: false,
    counterpartUnit: '',
    counterpartContact: '',
    counterpartPhone: '',
    remark: '',
    ...overrides,
  };
}

function honorInput(overrides: Record<string, unknown> = {}) {
  return {
    title: '示范荣誉',
    awardedOn: { kind: 'plain', date: '2026-06-20' } as const,
    honorType: '表彰（先进集体/个人）',
    level: '市级',
    issuingOrg: '示范颁发单位',
    documentNo: '',
    personalRole: '',
    evidenceLocation: '',
    relatedWorkId: null,
    remark: '',
    ...overrides,
  };
}

/** The workflow, step by step, exactly as a user performs it. */
async function runWorkflow() {
  const work = await createWorkRecord(workInput({ title: '被引用的工作事项' }));
  const honor = await createHonorRecord(
    honorInput({ title: '与该工作关联的荣誉', relatedWorkId: work.id }),
  );
  await addProgressEntry({ recordId: work.id, note: '工作进展一' });
  await softDeleteRecord(work.id);
  await purgeRecord(work.id);
  return { work, honor };
}

describe('Phase-1.3 invariant: purging a linked work record leaves a restorable state', () => {
  it('the honour survives with its reference DETACHED, not dangling', async () => {
    const { work, honor } = await runWorkflow();

    const after = await listRecords();
    const survivor = after.records.find((record) => record.id === honor.id);
    expect(survivor, 'the honour must survive').toBeTruthy();
    expect(survivor?.title).toBe('与该工作关联的荣誉');

    // Phase 1.2 leaves this pointing at a record that no longer exists.
    expect(
      isHonorRecord(survivor!) && survivor.relatedWorkId,
      'the reference must be detached when the work record is purged',
    ).toBeNull();
    // Every row still validates individually — which is why row-level checks cannot catch this.
    const snapshot = await readStoreSnapshot();
    expect(snapshot.invalid.records).toHaveLength(0);
    expect(after.records.some((record) => record.id === work.id)).toBe(false);
  });

  it('the live state is not treated as backup-viable while a relation dangles', async () => {
    await runWorkflow();

    /*
     * Phase 1.2: `complete` is true and `createBackup()` succeeds, marking the data backed up. The
     * invariant is that a backup may only be labelled complete when it is restorable, so a dangling
     * relation must prevent it.
     */
    const snapshot = await readBackupSnapshot();
    const dangling = snapshot.input.records.filter(
      (record) => isHonorRecord(record) && record.relatedWorkId !== null,
    );
    const workIds = new Set(
      snapshot.input.records.filter((record) => record.kind === 'work').map((record) => record.id),
    );
    const unresolved = dangling.filter(
      (record) => isHonorRecord(record) && !workIds.has(record.relatedWorkId!),
    );
    expect(unresolved, 'the snapshot must contain no unresolved honour reference').toEqual([]);

    const meta = await getMeta();
    expect(
      meta?.lastBackupAt,
      'no complete backup may have been recorded for a broken state',
    ).toBeNull();
  });

  it('the backup the application produced must be accepted by the same version', async () => {
    await runWorkflow();

    // Phase 1.2 produces this file happily...
    const result = await createBackup();
    expect(result.envelope.completeness).toBe('complete');

    // ...and then refuses to restore it. That contradiction is the defect.
    const plan = await buildImportPlan({
      parsed: result.envelope,
      mode: 'replace',
      existing: (await listRecords()).records,
      existingProgressIds: [],
    });
    expect(
      planBlockers(plan),
      'a file the application labelled complete must be exact-restorable',
    ).toEqual([]);
  });
});
