import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { SETTINGS_KEY } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import { createWorkRecord, updateRecord } from '@/db/repositories/records';
import { getMeta, recordCanonicalBackup } from '@/db/repositories/taxonomy';
import { readStoreSnapshot } from '@/db/snapshot';
import { ABSENT_DATE } from '@/domain/dates';
import { assessBackupHealth, createBackup, readBackupSnapshot } from '@/services/backup';
import { createRecoveryExport } from '@/services/backup/recovery';

/**
 * Backup freshness: only a **complete** canonical backup, and only for the revision it captured.
 *
 * Two Phase-1.1 defects are pinned here.
 *
 * 1. `createBackup(..., { acknowledgeOmissions: true })` still called `recordBackupSuccess()`, so a
 *    file the application itself described as incomplete set `lastBackupRevision = dataRevision` and
 *    silenced the reminder. The user was told their data was safe by a file that could not restore it.
 *
 * 2. `recordBackupSuccess()` recorded whatever revision was current when the export *finished*, not
 *    the revision the snapshot captured. A mutation between snapshot and completion was therefore
 *    counted as included, and the health state read fresh for data the file did not contain.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-freshness-${String(counter)}`);
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

async function health() {
  const meta = await getMeta();
  return assessBackupHealth(meta, 7, '2026-09-21');
}

describe('only a complete canonical backup establishes freshness', () => {
  it('a clean canonical backup marks the data fresh', async () => {
    await createWorkRecord(workInput());
    const result = await createBackup();

    expect(result.omitted).toEqual([]);
    expect(result.markedFresh).toBe(true);
    expect(result.envelope.completeness).toBe('complete');

    const meta = await getMeta();
    expect(meta?.lastBackupRevision).toBe(meta?.dataRevision);
    expect((await health()).state).toBe('fresh');
  });

  it('REGRESSION: an acknowledged incomplete export does NOT mark the data fresh', async () => {
    await createWorkRecord(workInput());
    // Plant a corrupt row so the export is necessarily incomplete.
    await db.records.put({ id: 'corrupt', kind: 'work', title: 7 } as never);

    const before = await getMeta();
    expect(before?.lastBackupRevision).toBeNull();

    const result = await createBackup(new Date(), { acknowledgeOmissions: true });
    expect(result.omitted).toEqual(['corrupt']);
    expect(result.envelope.completeness).toBe('incomplete');
    expect(result.markedFresh, 'an incomplete file must not establish freshness').toBe(false);

    const after = await getMeta();
    expect(after?.lastBackupRevision, 'must remain unset').toBeNull();
    expect(after?.lastBackupAt, 'no backup timestamp may be recorded either').toBeNull();
    expect((await health()).state).toBe('never');
  });

  it('an incomplete export does not overwrite an earlier good backup state', async () => {
    await createWorkRecord(workInput());
    await createBackup();
    const good = await getMeta();
    expect((await health()).state).toBe('fresh');

    // The store becomes corrupt afterwards; the user knowingly exports the degraded file.
    await db.records.put({ id: 'corrupt', kind: 'work', title: 7 } as never);
    await createBackup(new Date(), { acknowledgeOmissions: true });

    const after = await getMeta();
    expect(after?.lastBackupRevision).toBe(good?.lastBackupRevision);
    expect(after?.lastBackupAt).toBe(good?.lastBackupAt);
  });

  it('a diagnostic recovery export never marks the data fresh', async () => {
    await createWorkRecord(workInput());
    await db.records.put({ id: 'corrupt', kind: 'work', title: 7 } as never);

    await createRecoveryExport();

    const meta = await getMeta();
    expect(meta?.lastBackupRevision).toBeNull();
    expect(meta?.lastBackupAt).toBeNull();
    expect((await health()).state).toBe('never');
  });

  it('XLSX and DOCX exports never mark the data fresh', { timeout: 60_000 }, async () => {
    const record = await createWorkRecord(workInput({ title: '导出用示范事项' }));
    const settings = await db.settings.get(SETTINGS_KEY);
    expect(settings).toBeTruthy();

    const { buildWorkbook } = await import('@/services/export/xlsx');
    await buildWorkbook({
      records: [record],
      categories: [],
      groups: [],
      today: '2026-09-21',
      generatedAt: '2026-09-21T09:00:00.000Z',
    });

    const { buildPeriodReport } = await import('@/services/export/docx');
    const { summarise } = await import('@/domain/reports');
    const period = {
      type: 'month' as const,
      start: '2026-09-01',
      endExclusive: '2026-10-01',
      label: '2026 年 9 月',
    };
    await buildPeriodReport({
      period,
      work: [record],
      honors: [],
      summary: summarise([record], [], { today: '2026-09-21' }),
      appTitle: settings!.value.appTitle,
      categories: [],
      today: '2026-09-21',
      generatedAt: '2026-09-21T09:00:00.000Z',
      includeHonors: true,
      includeSummary: true,
    });

    const meta = await getMeta();
    expect(meta?.lastBackupAt, 'a report is not a backup').toBeNull();
    expect(meta?.lastBackupRevision).toBeNull();
  });
});

describe('the captured-revision race', () => {
  it('REGRESSION: a mutation between snapshot and completion leaves the backup stale', async () => {
    const record = await createWorkRecord(workInput({ title: '原标题' }));

    // 1. Snapshot at R1 — this is the state the file would contain.
    const snapshot = await readBackupSnapshot();
    const r1 = snapshot.capturedRevision;
    expect(r1).not.toBeNull();

    // 2. Data moves on before the export's bookkeeping runs: another tab, or the user typing while
    //    a large export serialises. Nothing artificial is removed to make this reproduce.
    await updateRecord(record.id, { title: '导出期间改过的标题' });
    const r2 = (await getMeta())?.dataRevision;
    expect(r2).toBeGreaterThan(r1 ?? -1);

    // 3. The R1 file completes and records itself.
    await recordCanonicalBackup({
      capturedRevision: r1,
      recordCount: snapshot.input.records.length,
    });

    const meta = await getMeta();
    expect(meta?.lastBackupRevision, 'must be the revision the file captured').toBe(r1);
    expect(meta?.dataRevision, 'the current revision is never rewound').toBe(r2);

    const state = await health();
    expect(state.state, 'the file does not contain R2, so the backup is stale').toBe('stale');
    expect(state.state === 'stale' && state.reason).toBe('data-changed');
  });

  it('the ordinary no-race case is fresh', async () => {
    await createWorkRecord(workInput());
    const snapshot = await readBackupSnapshot();
    await recordCanonicalBackup({
      capturedRevision: snapshot.capturedRevision,
      recordCount: snapshot.input.records.length,
    });

    const meta = await getMeta();
    expect(meta?.lastBackupRevision).toBe(meta?.dataRevision);
    expect((await health()).state).toBe('fresh');
  });

  it('the envelope carries the captured revision, so the file itself states what it holds', async () => {
    await createWorkRecord(workInput());
    const snapshot = await readStoreSnapshot();
    const result = await createBackup();
    expect(result.envelope.dataRevision).toBe(snapshot.capturedRevision);
  });

  it('a later mutation makes even a correctly recorded backup stale', async () => {
    const record = await createWorkRecord(workInput());
    await createBackup();
    expect((await health()).state).toBe('fresh');

    await updateRecord(record.id, { title: '备份之后改的' });
    const state = await health();
    expect(state.state).toBe('stale');
    expect(state.state === 'stale' && state.reason).toBe('data-changed');
  });
});
