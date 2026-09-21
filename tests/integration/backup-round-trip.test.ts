import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  listProgressEntries,
  listRecords,
  softDeleteRecord,
} from '@/db/repositories/records';
import { addCategory, getSettings, listCategories, saveSettings } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { buildEnvelope, canonicalJson, serialiseEnvelope } from '@/services/backup/envelope';
import { snapshotForBackup } from '@/services/backup';
import { applyImportPlan, ImportBlockedError } from '@/services/import/apply';
import { ImportParseError, buildImportPlan, detectSource } from '@/services/import/plan';
import {
  LEGACY_EDGE_CASES,
  duplicateIdBackup,
  legacyArrayBackup,
  legacySplitBackup,
  legacyVersionedBackup,
} from '../fixtures/legacy-backups';

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-work-desk-backup-test-${String(counter)}`);
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

async function seedStore(): Promise<void> {
  const work = await createWorkRecord(
    workInput({ title: '甲事项', counterpartPhone: '0579-8311' }),
  );
  await createWorkRecord(workInput({ title: '乙事项', status: 'completed' }));
  await createHonorRecord({
    title: '示范荣誉',
    awardedOn: { kind: 'plain', date: '2026-06-20' },
    honorType: '感谢信',
    level: '省级',
    issuingOrg: '示范单位',
    documentNo: '示范函〔2026〕1号',
    personalRole: '主要承办人',
    evidenceLocation: '档案柜',
    relatedWorkId: null,
    remark: '',
  });
  await addProgressEntry({ recordId: work.id, note: '示范进展一' });
  await addProgressEntry({ recordId: work.id, note: '示范进展二' });
  const trashed = await createWorkRecord(workInput({ title: '回收站里的' }));
  await softDeleteRecord(trashed.id);
  await addCategory('自定义分类');
}

describe('export/import round trip', () => {
  it('restores an identical store from its own backup', async () => {
    await seedStore();
    const before = await snapshotForBackup();
    const envelope = await buildEnvelope(before, '2026-09-21T09:00:00.000Z');
    const text = serialiseEnvelope(envelope);

    // Wipe and restore from the serialised file, exactly as a user would.
    await db.records.clear();
    await db.progressEntries.clear();
    expect((await listRecords()).records).toHaveLength(0);

    const plan = await buildImportPlan({
      parsed: JSON.parse(text),
      mode: 'replace',
      existing: [],
    });
    expect(plan.format).toBe('civic-envelope');
    expect(plan.checksum).toBe('match');
    expect(plan.countsConsistent).toBe(true);
    await applyImportPlan(plan);

    const after = await snapshotForBackup();
    expect(canonicalJson(after.records)).toBe(canonicalJson(before.records));
    expect(canonicalJson(after.progressEntries)).toBe(canonicalJson(before.progressEntries));
  });

  it('keeps soft-deleted records in the backup so a restore is complete', async () => {
    await seedStore();
    const snapshot = await snapshotForBackup();
    expect(snapshot.records.some((record) => record.deletedAt !== null)).toBe(true);
  });

  it('rejects a tampered backup rather than importing it', async () => {
    await seedStore();
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const tampered = structuredClone(envelope);
    const first = tampered.payload.records[0];
    if (first) first.title = '被篡改的标题';

    const plan = await buildImportPlan({ parsed: tampered, mode: 'replace', existing: [] });
    expect(plan.checksum).toBe('mismatch');
    await expect(applyImportPlan(plan)).rejects.toBeInstanceOf(ImportBlockedError);
    // Nothing was written.
    expect((await listRecords()).records.some((r) => r.title === '被篡改的标题')).toBe(false);
  });

  it('refuses a structurally invalid CivicWorkDesk envelope', () => {
    expect(() =>
      detectSource({ application: 'civic-work-desk', backupFormatVersion: 1, payload: {} }),
    ).toThrow(ImportParseError);
  });

  it('refuses an unrecognisable document', () => {
    expect(() => detectSource({ something: 'else' })).toThrow(ImportParseError);
    expect(() => detectSource('a string')).toThrow(ImportParseError);
    expect(() => detectSource(42)).toThrow(ImportParseError);
  });
});

describe('merge mode', () => {
  it('adds new records and never overwrites an existing one', async () => {
    await seedStore();
    const existing = (await listRecords()).records;
    const original = existing[0];
    expect(original).toBeDefined();
    if (!original) return;

    // Build the incoming file properly: mutate the snapshot, then rebuild the envelope so its
    // counts and checksum describe what it actually carries. (Hand-editing the envelope after
    // building it is what the integrity guards exist to catch.)
    const snapshot = await snapshotForBackup();
    const mutated = snapshot.records.map((record, index) =>
      index === 0 ? { ...record, title: '文件里的不同标题' } : record,
    );
    const brandNew = { ...(mutated[0] ?? original), id: 'brand-new-id', title: '文件里的新记录' };
    const incoming = await buildEnvelope(
      { ...snapshot, records: [...mutated, brandNew] },
      '2026-09-21T09:00:00.000Z',
    );

    const plan = await buildImportPlan({ parsed: incoming, mode: 'merge', existing });
    expect(plan.summary.conflicts).toBeGreaterThan(0);
    expect(plan.accepted.map((r) => r.id)).toContain('brand-new-id');

    await applyImportPlan(plan);

    const after = (await listRecords()).records;
    expect(after.find((r) => r.id === original.id)?.title).toBe(original.title);
    expect(after.some((r) => r.id === 'brand-new-id')).toBe(true);
  });

  it('flags a conflict whose content is byte-identical, so it reads as harmless', async () => {
    await seedStore();
    const existing = (await listRecords()).records;
    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T09:00:00.000Z');
    const plan = await buildImportPlan({ parsed: envelope, mode: 'merge', existing });
    expect(plan.summary.conflicts).toBe(existing.length);
    expect(plan.summary.identicalConflicts).toBe(existing.length);
    expect(plan.accepted).toHaveLength(0);
  });

  it('detects duplicate ids inside the SAME source file and rejects the second', async () => {
    // The legacy importer built its `existIds` set once, before the loop, and never added to it —
    // so two rows sharing an id in one file were both inserted.
    const plan = await buildImportPlan({
      parsed: duplicateIdBackup(),
      mode: 'merge',
      existing: [],
    });
    expect(plan.strategy).toBe('merge');
    expect(plan.duplicateIdsInSource).toEqual(['dup_1']);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.rejected).toHaveLength(1);

    // Merge tolerates a messy source: the duplicate is reported and the first row is written.
    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(1);
  });
});

describe('replace mode', () => {
  it('destroys the previous store and reports how much it destroyed', async () => {
    await seedStore();
    const before = (await listRecords()).records.length;
    expect(before).toBeGreaterThan(0);

    const plan = await buildImportPlan({
      parsed: legacyArrayBackup(),
      mode: 'replace',
      existing: (await listRecords()).records,
    });
    const outcome = await applyImportPlan(plan);

    expect(outcome.recordsDestroyed).toBe(before);
    const after = (await listRecords()).records;
    expect(after).toHaveLength(plan.accepted.length);
    expect(after.every((r) => r.id.startsWith('fix_'))).toBe(true);
    expect(await listProgressEntries()).toHaveLength(0);
  });

  it('adopts settings in replace mode but leaves them alone in merge mode', async () => {
    await seedStore();
    await saveSettings({ ...(await getSettings()), appTitle: '本机设置的标题' });
    const snapshot = await snapshotForBackup();
    const envelope = await buildEnvelope(
      { ...snapshot, settings: { ...snapshot.settings, appTitle: '文件里的标题' } },
      '2026-09-21T09:00:00.000Z',
    );

    // Merge against the REAL destination. Every id already exists, so merge accepts nothing and
    // leaves settings alone — the caller must not misreport the destination, because the write
    // path uses `bulkAdd` and would (correctly) reject an inconsistent plan.
    const live = (await listRecords()).records;
    const mergePlan = await buildImportPlan({ parsed: envelope, mode: 'merge', existing: live });
    expect(mergePlan.strategy).toBe('merge');
    await applyImportPlan(mergePlan);
    expect((await getSettings()).appTitle).toBe('本机设置的标题');

    const replacePlan = await buildImportPlan({
      parsed: envelope,
      mode: 'replace',
      existing: live,
    });
    await applyImportPlan(replacePlan);
    expect((await getSettings()).appTitle).toBe('文件里的标题');
  });

  it('adds categories the file brings but keeps a locally renamed one', async () => {
    await seedStore();
    const local = await addCategory('本机分类');
    const snapshot = await snapshotForBackup();
    const envelope = await buildEnvelope(
      {
        ...snapshot,
        categories: snapshot.categories.map((category) =>
          category.id === local.id ? { ...category, name: '文件里的名字' } : category,
        ),
      },
      '2026-09-21T09:00:00.000Z',
    );

    const plan = await buildImportPlan({
      parsed: envelope,
      mode: 'merge',
      existing: (await listRecords()).records,
    });
    await applyImportPlan(plan);

    expect((await listCategories()).find((c) => c.id === local.id)?.name).toBe('本机分类');
  });
});

describe('legacy formats', () => {
  it('imports the {version, exportTime, works} envelope', async () => {
    const plan = await buildImportPlan({
      parsed: legacyVersionedBackup(),
      mode: 'merge',
      existing: [],
    });
    expect(plan.format).toBe('legacy-versioned');
    // One fixture has no title and is the only rejection.
    expect(plan.accepted).toHaveLength(LEGACY_EDGE_CASES.length - 1);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.warnings.length).toBeGreaterThan(0);

    await applyImportPlan(plan);
    const { records } = await listRecords();
    expect(records).toHaveLength(LEGACY_EDGE_CASES.length - 1);
    expect(records.filter((r) => r.kind === 'honor')).toHaveLength(2);
  });

  it('imports the {works, honors} split shape and classifies the honours correctly', async () => {
    const plan = await buildImportPlan({
      parsed: legacySplitBackup(),
      mode: 'merge',
      existing: [],
    });
    expect(plan.format).toBe('legacy-split');
    await applyImportPlan(plan);
    const { records } = await listRecords();
    const honor = records.find((r) => r.id === 'fix_split_honor');
    expect(honor?.kind).toBe('honor');
    expect(honor?.kind === 'honor' ? honor.level : undefined).toBe('单位内部');
  });

  it('imports a bare array with no envelope', async () => {
    const plan = await buildImportPlan({
      parsed: legacyArrayBackup(),
      mode: 'merge',
      existing: [],
    });
    expect(plan.format).toBe('legacy-array');
    expect(plan.accepted).toHaveLength(5);
    await applyImportPlan(plan);
    expect((await listRecords()).records).toHaveLength(5);
  });

  it('carries legacy progress entries into their own store', async () => {
    const plan = await buildImportPlan({
      parsed: legacyVersionedBackup(),
      mode: 'merge',
      existing: [],
    });
    await applyImportPlan(plan);
    const entries = await listProgressEntries('fix_013');
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.id.length > 0)).toBe(true);
  });

  it('is idempotent: re-importing the same legacy file adds nothing', async () => {
    const first = await buildImportPlan({
      parsed: legacyVersionedBackup(),
      mode: 'merge',
      existing: [],
    });
    await applyImportPlan(first);
    const afterFirst = (await listRecords()).records;

    const second = await buildImportPlan({
      parsed: legacyVersionedBackup(),
      mode: 'merge',
      existing: afterFirst,
    });
    expect(second.accepted).toHaveLength(0);
    expect(second.summary.conflicts).toBe(afterFirst.length);
    await applyImportPlan(second);
    expect((await listRecords()).records).toHaveLength(afterFirst.length);
  });
});
