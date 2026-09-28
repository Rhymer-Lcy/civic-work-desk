import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import { listProgressEntries, listRecords } from '@/db/repositories/records';
import { listCategories, listGroups } from '@/db/repositories/taxonomy';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { SCHEMA_VERSION } from '@/db/schema';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord } from '@/domain/types';
import { RelationalIntegrityError, createBackup, snapshotForBackup } from '@/services/backup';
import {
  BACKUP_FORMAT_VERSION,
  buildEnvelope,
  checksumMaterial,
  sha256Hex,
} from '@/services/backup/envelope';
import type { BackupEnvelope } from '@/services/backup/envelope';
import { applyImportPlan } from '@/services/import/apply';
import { ImportParseError, buildImportPlan, planBlockers } from '@/services/import/plan';
import { makeHonor, makeProgress, makeWork } from '../fixtures/records';

/**
 * Backups across the Phase-5 record-schema change (docs/phase-5-product-evolution.md §10.2).
 *
 *   - `backupFormatVersion` stays 3: the envelope did not change;
 *   - `schemaVersion` becomes 2: work records carry `parentWorkId`;
 *   - a schema-1 file is validated in its own shape, verified as received, then migrated;
 *   - a schema-2 file round-trips its hierarchy exactly;
 *   - hierarchy damage blocks an exact restore and blocks a backup of the live store, exactly as any
 *     other relational damage does.
 */

const PHASE_1_2_FIXTURE = 'tests/fixtures/phase-1-2-canonical-v3.json';

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-schema-v2-backup-${String(counter)}`);
  await db.open();
  await ensureSeedData(db);
  setDatabase(db);
});

afterEach(async () => {
  setDatabase(null);
  await db.delete();
});

/** A three-level hierarchy with a duplicate title in two branches, written straight to the store. */
function hierarchyRecords(): AnyRecord[] {
  return [
    makeWork({ id: 'root', title: '一级任务' }),
    makeWork({ id: 'child-a', title: '同名子任务', parentWorkId: 'root' }),
    makeWork({ id: 'child-b', title: '二级子任务', parentWorkId: 'root', status: 'completed' }),
    makeWork({ id: 'grandchild', title: '同名子任务', parentWorkId: 'child-a' }),
    makeWork({ id: 'other-root', title: '另一个一级任务' }),
    makeHonor({ id: 'honor', relatedWorkId: 'grandchild' }),
  ];
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

/** Recompute a v3 digest after a deliberate edit, so a test isolates the rule it is about. */
async function reseal(envelope: BackupEnvelope): Promise<BackupEnvelope> {
  return {
    ...envelope,
    checksum: { ...envelope.checksum, value: await sha256Hex(checksumMaterial(envelope)) },
  };
}

function byId(records: readonly AnyRecord[]): AnyRecord[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

describe('writing: a new backup declares schema 2 and carries the hierarchy', () => {
  it('keeps the envelope format at 3 and sets schemaVersion to 2', async () => {
    await db.records.bulkAdd(hierarchyRecords());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-29T00:00:00.000Z');
    expect(BACKUP_FORMAT_VERSION).toBe(3);
    expect(envelope.backupFormatVersion).toBe(3);
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.schemaVersion).toBe(2);
    for (const record of envelope.payload.records) {
      if (record.kind === 'work') expect(Object.hasOwn(record, 'parentWorkId')).toBe(true);
      else expect(Object.hasOwn(record, 'parentWorkId')).toBe(false);
    }
  });
});

describe('round trip: build → backup → restore into an empty database → identical hierarchy', () => {
  it('restores every parent link exactly', async () => {
    const original = hierarchyRecords();
    await db.records.bulkAdd(original);
    await db.progressEntries.add(makeProgress('grandchild', '三级任务的进展'));
    const envelope = JSON.parse(
      JSON.stringify(await buildEnvelope(await snapshotForBackup(), '2026-09-29T00:00:00.000Z')),
    ) as unknown;

    // A different, empty installation.
    setDatabase(null);
    await db.delete();
    db = createDatabase(`civic-schema-v2-backup-${String(counter)}-restore`);
    await db.open();
    await ensureSeedData(db);
    setDatabase(db);

    const plan = await planFor(envelope, 'replace');
    expect(plan.checksum).toBe('match');
    expect(plan.exactRestorePossible).toBe(true);
    expect(planBlockers(plan)).toEqual([]);
    await applyImportPlan(plan);

    const { records } = await listRecords();
    expect(byId(records)).toEqual(byId(original));
    const links = records
      .filter(isWorkRecord)
      .map((record) => `${record.id}->${record.parentWorkId ?? 'null'}`)
      .sort();
    expect(links).toEqual([
      'child-a->root',
      'child-b->root',
      'grandchild->child-a',
      'other-root->null',
      'root->null',
    ]);
  });
});

describe('reading a schema-1 file (written before Phase 5)', () => {
  const fixture = (): Record<string, unknown> =>
    JSON.parse(readFileSync(PHASE_1_2_FIXTURE, 'utf8')) as Record<string, unknown>;

  it('verifies the digest against the file as received, then makes every task top-level', async () => {
    const raw = fixture();
    expect(raw['schemaVersion']).toBe(1);
    const plan = await planFor(raw, 'replace');
    expect(plan.checksum, 'the digest covers the received records, not the migrated ones').toBe(
      'match',
    );
    expect(plan.countsConsistent).toBe(true);
    const work = plan.accepted.filter(isWorkRecord);
    expect(work.length).toBeGreaterThan(0);
    for (const record of work) expect(record.parentWorkId).toBeNull();
    for (const record of plan.accepted.filter((r) => r.kind === 'honor')) {
      expect(Object.hasOwn(record, 'parentWorkId')).toBe(false);
    }

    await applyImportPlan(plan);
    const stored = await db.records.toArray();
    for (const row of stored) {
      if (row.kind === 'work') expect(row.parentWorkId).toBeNull();
    }
  });

  it('refuses a schema-1 file whose work record carries a parent — schema 1 had no hierarchy', async () => {
    const raw = fixture();
    const records = (raw['payload'] as { records: Record<string, unknown>[] }).records;
    const work = records.find((record) => record['kind'] === 'work');
    if (!work) throw new Error('fixture has no work record');
    work['parentWorkId'] = 'someone';
    await expect(planFor(raw, 'replace')).rejects.toBeInstanceOf(ImportParseError);
  });

  it('refuses a schema-2 file whose work record has no parentWorkId at all', async () => {
    await db.records.bulkAdd(hierarchyRecords());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-29T00:00:00.000Z');
    const stripped = JSON.parse(JSON.stringify(envelope)) as BackupEnvelope;
    const first = stripped.payload.records.find((record) => record.kind === 'work');
    if (!first) throw new Error('no work record');
    delete (first as Partial<typeof first>).parentWorkId;
    await expect(planFor(await reseal(stripped), 'replace')).rejects.toBeInstanceOf(
      ImportParseError,
    );
  });

  it('refuses a file from a newer record schema before looking at its payload', async () => {
    const raw = fixture();
    raw['schemaVersion'] = 3;
    await expect(planFor(raw, 'replace')).rejects.toThrow('更新的数据库架构（v3）');
  });
});

describe('hierarchy damage in an archive blocks an exact restore', () => {
  async function damagedEnvelope(
    edit: (records: AnyRecord[]) => AnyRecord[],
  ): Promise<BackupEnvelope> {
    await db.records.bulkAdd(hierarchyRecords());
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-29T00:00:00.000Z');
    const records = edit(JSON.parse(JSON.stringify(envelope.payload.records)) as AnyRecord[]);
    return reseal({ ...envelope, payload: { ...envelope.payload, records } });
  }

  const reparent = (records: AnyRecord[], id: string, parent: string | null): AnyRecord[] =>
    records.map((record) =>
      record.id === id && record.kind === 'work' ? { ...record, parentWorkId: parent } : record,
    );

  it.each([
    ['a cycle', (r: AnyRecord[]) => reparent(r, 'root', 'grandchild'), 'work-hierarchy-cycle'],
    [
      'a dangling parent',
      (r: AnyRecord[]) => reparent(r, 'child-b', 'gone'),
      'dangling-parent-work',
    ],
    [
      'an honour as parent',
      (r: AnyRecord[]) => reparent(r, 'child-b', 'honor'),
      'parent-is-not-work',
    ],
    [
      'a fourth level',
      (r: AnyRecord[]) => [...r, makeWork({ id: 'level-4', parentWorkId: 'grandchild' })],
      'work-hierarchy-too-deep',
    ],
  ] as const)('%s', async (_label, edit, kind) => {
    const plan = await planFor(await damagedEnvelope(edit), 'replace');
    expect(plan.checksum).toBe('match');
    expect(plan.integrityIssues.map((issue) => issue.kind)).toContain(kind);
    expect(plan.exactRestorePossible).toBe(false);
    expect(planBlockers(plan).join(' ')).toContain('关联关系不自洽');
  });
});

describe('the live store', () => {
  it('refuses to write a complete backup while a parent link dangles', async () => {
    await db.records.bulkAdd([makeWork({ id: 'orphan', parentWorkId: 'purged-parent' })]);
    await expect(createBackup()).rejects.toBeInstanceOf(RelationalIntegrityError);
  });
});
