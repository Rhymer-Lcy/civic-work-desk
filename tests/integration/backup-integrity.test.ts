import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import { createWorkRecord, listRecords } from '@/db/repositories/records';
import { getSettings } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import {
  IncompleteBackupError,
  buildRecoveryExport,
  readBackupSnapshot,
  readRecoverySnapshot,
  RECOVERY_APP_ID,
} from '@/services/backup';
import { buildEnvelope } from '@/services/backup/envelope';
import { snapshotForBackup } from '@/services/backup';
import { applyImportPlan } from '@/services/import/apply';
import { ImportParseError, buildImportPlan, detectSource } from '@/services/import/plan';

/**
 * Backup integrity — invalid stored rows, and backup/schema version compatibility.
 *
 * Phase 1 defects reproduced here:
 *  - `snapshotForBackup()` used only the *valid* records, so a corrupt row silently vanished from
 *    a file the UI called a complete backup — while Diagnostics told the user to export that very
 *    file as evidence.
 *  - envelope validation accepted `backupFormatVersion >= 1` and `schemaVersion >= 1`, so a file
 *    from a future build was read purely because its shape happened to validate.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-backup-integrity-${String(counter)}`);
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

/**
 * Plant a row that cannot pass the domain schema.
 *
 * Synthetic: an impossible calendar date and a missing discriminant field. No real data.
 */
async function plantInvalidRecord(id = 'corrupt-1'): Promise<void> {
  await db.records.put({
    id,
    kind: 'work',
    title: '损坏的示范记录',
    // 2026-02-30 does not exist; the date model refuses to shift it silently.
    occurredOn: { kind: 'plain', date: '2026-02-30' },
    status: 'not-a-real-status',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
  } as never);
}

async function plantInvalidProgress(id = 'corrupt-progress-1'): Promise<void> {
  await db.progressEntries.put({
    id,
    recordId: 'whatever',
    occurredOn: { kind: 'plain', date: 'not-a-date' },
    note: '损坏的进展',
  } as never);
}

describe('invalid stored rows are never silently omitted from a backup', () => {
  it('REGRESSION: refuses to produce a "complete" backup while dropping a corrupt row', async () => {
    await createWorkRecord(workInput({ title: '正常记录' }));
    await plantInvalidRecord();

    // The valid-row read still excludes it, as designed...
    const read = await listRecords();
    expect(read.records).toHaveLength(1);
    expect(read.invalid).toHaveLength(1);

    // ...and the backup path now refuses rather than quietly shipping an incomplete archive.
    const { createBackup } = await import('@/services/backup');
    await expect(createBackup()).rejects.toBeInstanceOf(IncompleteBackupError);

    try {
      await createBackup();
      expect.unreachable('createBackup must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteBackupError);
      const incomplete = error as IncompleteBackupError;
      expect(incomplete.invalidRecordIds).toEqual(['corrupt-1']);
      expect(incomplete.message).toContain('未通过校验');
    }
  });

  it('records the omission in the envelope when the user knowingly proceeds', async () => {
    await createWorkRecord(workInput());
    await plantInvalidRecord('corrupt-2');
    await plantInvalidProgress('corrupt-progress-2');

    const snapshot = await readBackupSnapshot();
    expect(snapshot.invalidRecords.map((r) => r.id)).toEqual(['corrupt-2']);
    expect(snapshot.invalidProgressEntries.map((r) => r.id)).toEqual(['corrupt-progress-2']);

    const envelope = await buildEnvelope(snapshot.input, '2026-09-21T09:00:00.000Z');
    // The file itself states that it is not complete.
    expect(envelope.omittedInvalidRowIds).toEqual(['corrupt-2', 'corrupt-progress-2']);
    expect(envelope.backupFormatVersion).toBe(3);
    expect(envelope.completeness).toBe('incomplete');
  });

  it('a clean store produces a backup that declares itself complete', async () => {
    await createWorkRecord(workInput());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    expect(envelope.omittedInvalidRowIds).toEqual([]);
  });

  it('REGRESSION: the diagnostic recovery export preserves the raw invalid rows', async () => {
    await createWorkRecord(workInput({ title: '正常记录' }));
    await plantInvalidRecord('corrupt-3');
    await plantInvalidProgress('corrupt-progress-3');

    const snapshot = await readRecoverySnapshot();
    expect(snapshot.invalidRecords).toHaveLength(1);
    expect(snapshot.invalidProgressEntries).toHaveLength(1);

    const recovery = await buildRecoveryExport('2026-09-21T09:00:00.000Z');
    expect(recovery.application).toBe(RECOVERY_APP_ID);
    expect(recovery.restorable).toBe(false);
    expect(recovery.counts).toMatchObject({
      validRecords: 1,
      invalidRecords: 1,
      invalidProgressEntries: 1,
    });

    // The raw row survives verbatim, including the values that made it invalid.
    const raw = recovery.invalidRecords[0]?.raw as Record<string, unknown>;
    expect(raw['id']).toBe('corrupt-3');
    expect(raw['status']).toBe('not-a-real-status');
    expect(raw['occurredOn']).toEqual({ kind: 'plain', date: '2026-02-30' });
    expect(recovery.invalidRecords[0]?.reason).toBeTruthy();
    expect(recovery.rawChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the recovery export is not importable', async () => {
    await plantInvalidRecord('corrupt-4');
    const recovery = await buildRecoveryExport('2026-09-21T09:00:00.000Z');
    // It must not be mistaken for a backup: the importer refuses it outright.
    expect(() => detectSource(recovery)).toThrow(ImportParseError);
  });

  it('a later known-good canonical restore still succeeds and clears the corruption', async () => {
    await createWorkRecord(workInput({ title: '正常记录' }));
    const good = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');

    await plantInvalidRecord('corrupt-5');
    expect((await listRecords()).invalid).toHaveLength(1);

    const plan = await buildImportPlan({
      parsed: good,
      mode: 'replace',
      existing: (await listRecords()).records,
    });
    await applyImportPlan(plan);

    const after = await listRecords();
    expect(after.invalid).toHaveLength(0);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]?.title).toBe('正常记录');
  });
});

describe('backup format and schema compatibility', () => {
  async function validEnvelope() {
    await createWorkRecord(workInput());
    return buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
  }

  it('REGRESSION: rejects an unsupported FUTURE backup format version', async () => {
    const envelope = { ...(await validEnvelope()), backupFormatVersion: 999 };
    // Phase 1 accepted this: `min(1)` passed and the shape happened to validate.
    expect(() => detectSource(envelope)).toThrow(ImportParseError);
    try {
      detectSource(envelope);
      expect.unreachable('must throw');
    } catch (error) {
      const parse = error as ImportParseError;
      expect(parse.message).toContain('更新版本');
      expect(parse.message).toContain('v999');
      // The message must be precise, not a generic validation failure.
      expect(parse.message).not.toContain('未通过校验');
      expect(parse.details.join(' ')).toContain('升级应用');
    }
  });

  it('REGRESSION: rejects an unsupported FUTURE database schema version', async () => {
    const envelope = { ...(await validEnvelope()), schemaVersion: 999 };
    try {
      detectSource(envelope);
      expect.unreachable('must throw');
    } catch (error) {
      const parse = error as ImportParseError;
      expect(parse.message).toContain('数据库架构');
      expect(parse.message).toContain('v999');
    }
  });

  it('rejects an envelope with no usable version declaration', async () => {
    const base = await validEnvelope();
    expect(() => detectSource({ ...base, backupFormatVersion: 'two' })).toThrow(ImportParseError);
    expect(() => detectSource({ ...base, schemaVersion: null })).toThrow(ImportParseError);
  });

  it('accepts a supported older format through an explicit migration', async () => {
    const current = await validEnvelope();
    // A genuine v1 file: no `omittedInvalidRowIds`, no `dataRevision`.
    const v1: Record<string, unknown> = { ...current, backupFormatVersion: 1 };
    delete v1['omittedInvalidRowIds'];
    delete v1['dataRevision'];

    const detected = detectSource(v1);
    expect(detected.format).toBe('civic-envelope');
    expect(detected.envelope?.backupFormatVersion).toBe(3);
    /*
     * Phase 1.1 asserted here that a migrated v1 file "claimed nothing was omitted". It could not
     * claim that: the format had no such field, and the build that wrote it dropped invalid rows
     * silently. Phase 1.2 classifies it as `unknown-legacy` — restorable, with the uncertainty
     * stated — rather than inferring completeness from a missing field.
     */
    expect(detected.envelope?.completeness).toBe('unknown-legacy');
    expect(detected.envelope?.omittedInvalidRowIds).toEqual([]);
    expect(detected.envelope?.dataRevision).toBeNull();
    // Its digest still covers only the payload, as v1 wrote it.
    expect(detected.envelope?.checksum.scope).toBe('payload');
  });

  it('a migrated v1 envelope still restores exactly', async () => {
    const current = await validEnvelope();
    const v1: Record<string, unknown> = { ...current, backupFormatVersion: 1 };
    delete v1['omittedInvalidRowIds'];
    delete v1['dataRevision'];

    const plan = await buildImportPlan({
      parsed: v1,
      mode: 'replace',
      existing: (await listRecords()).records,
    });
    expect(plan.strategy).toBe('canonical-restore');
    expect(plan.completeness).toBe('unknown-legacy');
    expect(plan.requiresCompletenessAcknowledgement).toBe(true);
    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(1);
    expect(await getSettings()).toBeTruthy();
  });
});
