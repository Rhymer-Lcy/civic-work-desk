import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import { createWorkRecord, listProgressEntries, listRecords } from '@/db/repositories/records';
import { getSettings, listCategories, listGroups } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { isHonorRecord, isWorkRecord } from '@/domain/types';
import { readBackupSnapshot } from '@/services/backup';
import { applyImportPlan } from '@/services/import/apply';
import { buildImportPlan, planBlockers } from '@/services/import/plan';

/**
 * A genuine Phase-1.2 v3 archive must remain restorable.
 *
 * The fixture is **not hand-written**. It was produced by running the Phase-1.2 code at commit
 * `48480cf47fc6b9a6f5974de808e39f1576286a46` — `buildEnvelope(await snapshotForBackup(), …)` over a
 * store built through that version's repository calls — and saved verbatim, digest included. Writing
 * the shape by hand would only prove this build agrees with itself; this proves it agrees with the
 * previous one. The generator is `scripts/audit/generate-phase-1-2-fixture.test.ts`.
 *
 * Its contents are synthetic: placeholder names and a documentation-block phone number.
 *
 * Phase 1.3 changed relational rules and merge semantics but deliberately **not** the format, so this
 * file must still verify, still be judged complete, and still restore exactly.
 */

/*
 * A repo-relative path rather than `import.meta.url`: Vitest transforms this module, so `import.meta.url`
 * is not a `file:` URL here and `fileURLToPath` rejects it. Tests run from the project root.
 */
const FIXTURE = 'tests/fixtures/phase-1-2-canonical-v3.json';

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-v3-compat-${String(counter)}`);
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
    title: '本机记录',
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

async function planFor(parsed: unknown, mode: 'merge' | 'replace') {
  const [{ records }, progress, categories, groups] = await Promise.all([
    listRecords(),
    listProgressEntries(),
    listCategories(),
    listGroups(),
  ]);
  return buildImportPlan({
    parsed,
    mode,
    existing: records,
    existingProgressIds: progress.map((entry) => entry.id),
    existingCategoryIds: categories.map((category) => category.id),
    existingGroupIds: groups.map((group) => group.id),
  });
}

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
}

describe('a valid Phase-1.2 v3 archive remains compatible', () => {
  it('is the real thing: v3, complete, envelope-scoped digest', () => {
    const raw = loadFixture();
    expect(raw['backupFormatVersion']).toBe(3);
    expect(raw['completeness']).toBe('complete');
    expect(raw['omittedInvalidRowIds']).toEqual([]);
    expect((raw['checksum'] as { scope: string }).scope).toBe('envelope');
  });

  it('verifies, is judged complete, and restores exactly', async () => {
    await createWorkRecord(workInput({ title: '会被替换掉的本机记录' }));

    const plan = await planFor(loadFixture(), 'replace');
    expect(plan.format).toBe('civic-envelope');
    expect(plan.checksum, 'the Phase-1.2 digest must still verify').toBe('match');
    expect(plan.countsConsistent).toBe(true);
    expect(plan.completeness).toBe('complete');
    // The Phase-1.3 relational rules must find nothing wrong with a Phase-1.2 archive.
    expect(plan.integrityIssues).toEqual([]);
    expect(plan.exactRestorePossible).toBe(true);
    expect(planBlockers(plan)).toEqual([]);

    await applyImportPlan(plan);

    const after = await listRecords();
    expect(after.records).toHaveLength(2);
    const work = after.records.find(isWorkRecord);
    const honor = after.records.find(isHonorRecord);
    expect(work?.title).toBe('示范工作事项（Phase 1.2 归档）');
    expect(honor?.title).toBe('示范荣誉（关联工作）');
    // The relationship survives the restore, resolved against the restored record.
    expect(isHonorRecord(honor!) && honor.relatedWorkId).toBe(work?.id);
    expect((await listProgressEntries()).map((entry) => entry.note)).toEqual(['示范进展一']);
    expect((await getSettings()).appTitle).toBeTruthy();
  });

  it('the restored state is itself backup-viable, so the cycle closes', async () => {
    await applyImportPlan(await planFor(loadFixture(), 'replace'));
    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });

  it('merges into a populated destination without introducing a dangling reference', async () => {
    /*
     * The clock is pinned per test, so the local record takes `test-id-0001` — the same id the
     * fixture's work record has. That makes this a more interesting case than "everything is new",
     * and exactly the one Phase 1.2 got wrong:
     *
     *   - the work record is an id conflict and is skipped (never overwritten);
     *   - its progress entry is genuinely new and its record **exists in the destination**, so it
     *     merges — Phase 1.2 skipped it for not being part of this import;
     *   - the honour is new, and its `relatedWorkId` resolves against that destination record.
     */
    const local = await createWorkRecord(workInput({ title: '本机既有记录' }));
    expect(local.id).toBe('test-id-0001');

    const plan = await planFor(loadFixture(), 'merge');
    expect(plan.referenceRejections).toEqual([]);
    expect(plan.orphanProgress).toEqual([]);
    expect(plan.conflicts.map((conflict) => conflict.id)).toEqual(['test-id-0001']);
    expect(plan.accepted.map((record) => record.id)).toEqual(['test-id-0003']);
    expect(plan.acceptedProgress.map((entry) => entry.id)).toEqual(['test-id-0002']);
    expect(planBlockers(plan)).toEqual([]);

    await applyImportPlan(plan);
    const snapshot = await readBackupSnapshot();
    expect(snapshot.relationalIssues, 'a merge may never break live integrity').toEqual([]);
    expect(snapshot.complete).toBe(true);

    const after = await listRecords();
    expect(after.records).toHaveLength(2);
    // The local record kept its own title: a merge never overwrites.
    expect(after.records.find((record) => record.id === local.id)?.title).toBe('本机既有记录');
    const honor = after.records.find(isHonorRecord);
    expect(isHonorRecord(honor!) && honor.relatedWorkId).toBe(local.id);
    expect((await listProgressEntries()).map((entry) => entry.note)).toEqual(['示范进展一']);
  });

  it('a Phase-1.2 archive carrying relational corruption is still refused, and not repaired', async () => {
    /*
     * Existing v3 archives are not re-validated into acceptability. One that contains a dangling
     * reference — because Phase 1.2 could produce exactly that from a Trash purge — is refused for
     * exact restore with the reason stated, and nothing in it is rewritten.
     */
    const raw = loadFixture();
    const payload = raw['payload'] as {
      records: { kind: string; relatedWorkId?: string | null }[];
    };
    for (const record of payload.records) {
      if (record.kind === 'honor') record.relatedWorkId = 'purged-work-record';
    }

    const plan = await planFor(raw, 'replace');
    // The digest correctly reports the edit; the relational rules independently report the defect.
    expect(plan.checksum).toBe('mismatch');
    expect(plan.integrityIssues.map((issue) => issue.kind)).toEqual(['dangling-related-work']);
    expect(plan.exactRestorePossible).toBe(false);
    const blockers = planBlockers(plan).join(' ');
    expect(blockers).toContain('校验和不匹配');
    expect(blockers).toContain('荣誉引用了');
  });
});
