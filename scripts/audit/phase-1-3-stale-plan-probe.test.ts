import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  purgeRecord,
  softDeleteRecord,
} from '@/db/repositories/records';
import { getMeta, listCategories, listGroups } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { validateRelationalIntegrity } from '@/domain/integrity';
import { snapshotForBackup } from '@/services/backup';
import { buildEnvelope, canonicalJson, sha256Hex } from '@/services/backup/envelope';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan, planBlockers } from '@/services/import/plan';

/**
 * Probe: a stale import plan applied after the destination changed.
 *
 * Written against the **Phase-1.3** API surface (`e9547922ea701276ec37d316dba0761e5bf64f1f`) so it
 * runs unchanged on that commit, where each assertion states the Phase-1.3.1 invariant and therefore
 * fails. The maintained version of these assertions is
 * `tests/integration/import-concurrency.test.ts`.
 *
 * ## The gap
 *
 * `buildImportPlan` projects the final state from a destination read when the preview was built.
 * `applyImportPlan` then writes that plan. Between the two the user is looking at a dialog, and
 * another tab can mutate the same IndexedDB database. The plan was safe when it was checked and can be
 * unsafe when it is used — a time-of-check / time-of-use gap.
 *
 * ## How to reproduce
 *
 * ```bash
 * git worktree add ../p13 e9547922ea701276ec37d316dba0761e5bf64f1f
 * cd ../p13 && npm ci
 * cp <package>/scripts/audit/phase-1-3-stale-plan-probe.test.ts tests/integration/zz-probe.test.ts
 * npx vitest run tests/integration/zz-probe.test.ts
 * ```
 *
 * The scenario deliberately does **not** rebuild the plan after the intervening mutation: rebuilding
 * would avoid the defect rather than reproduce it.
 *
 * Excluded from lint and typecheck (see `eslint.config.js`): it is written against another commit's
 * API surface and belongs to no tsconfig project in this tree.
 */

let db;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-stale-plan-probe-${String(counter)}`);
  await db.open();
  await ensureSeedData(db);
  setDatabase(db);
});

function workInput(overrides = {}) {
  return {
    title: '示范工作事项',
    occurredOn: { kind: 'plain', date: '2026-09-01' },
    status: 'todo',
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

async function reseal(envelope) {
  const rest = { ...envelope };
  delete rest['checksum'];
  return {
    ...rest,
    checksum: { algorithm: 'sha-256', scope: 'envelope', value: await sha256Hex(canonicalJson(rest)) },
  };
}

describe('Phase-1.3.1 invariant: a confirmed plan is re-checked against the current store', () => {
  it('a merge whose target record was purged after the preview must be refused, not written', async () => {
    // Time A — the destination holds W, and a file carries a new note for it.
    const work = await createWorkRecord(workInput({ title: '预览时存在的工作事项' }));
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const incoming = await reseal({
      ...envelope,
      payload: {
        ...envelope.payload,
        progressEntries: [
          {
            id: 'incoming-progress-1',
            recordId: work.id,
            occurredOn: { kind: 'plain', date: '2026-09-10' },
            note: '来自文件的新进展',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
      counts: { ...envelope.counts, progressEntries: 1 },
    });

    const { records } = await listRecords();
    const plan = await buildImportPlan({
      parsed: incoming,
      mode: 'merge',
      existing: records,
      existingProgressIds: [],
      existingCategoryIds: (await listCategories()).map((category) => category.id),
      existingGroupIds: (await listGroups()).map((group) => group.id),
    });

    // The preview is valid at time A: the note is accepted, and W is a conflict because it exists.
    expect(planBlockers(plan), 'the preview must be applicable when it is built').toEqual([]);
    expect(plan.acceptedProgress.map((entry) => entry.id)).toEqual(['incoming-progress-1']);
    expect(plan.accepted.map((record) => record.id)).not.toContain(work.id);

    // Time B — another tab purges W. Nothing rebuilds the plan.
    await softDeleteRecord(work.id);
    await purgeRecord(work.id);
    const revisionBefore = (await getMeta()).dataRevision;

    // Time C — the user confirms the stale preview.
    let refused = false;
    try {
      await applyImportPlan(plan);
    } catch {
      refused = true;
    }

    /*
     * `expect.soft` so one run reports every way the old behaviour differs, instead of stopping at
     * the first difference. All four describe the same event: the stale plan was written.
     */
    expect.soft(refused, 'applying a stale plan must be refused').toBe(true);
    expect.soft(await listProgressEntries(), 'the orphan note must not be written').toEqual([]);

    const live = await listRecords();
    const issues = validateRelationalIntegrity({
      records: live.records,
      progressEntries: await listProgressEntries(),
      categories: await listCategories(),
      groups: await listGroups(),
    });
    expect.soft(issues, 'the live store must remain relationally valid').toEqual([]);
    expect
      .soft((await getMeta()).dataRevision, 'a refused import must not bump the revision')
      .toBe(revisionBefore);
  });
});
