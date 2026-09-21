import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import type { CivicWorkDeskDatabase } from '@/db/schema';
import { SETTINGS_KEY } from '@/db/schema';
import { ensureSeedData } from '@/db/migrations';
import { createWorkRecord, listRecords } from '@/db/repositories/records';
import { listCategories, listGroups, getSettings } from '@/db/repositories/taxonomy';
import { invalidRowCount, readStoreSnapshot, storeIsIntact } from '@/db/snapshot';
import { SETTINGS_ROW_ID } from '@/db/invalid-row';
import { ABSENT_DATE } from '@/domain/dates';
import { IncompleteBackupError, buildRecoveryExport, readBackupSnapshot } from '@/services/backup';
import { buildEnvelope } from '@/services/backup/envelope';

/**
 * Corruption must be detectable in **every** user-data store.
 *
 * Phase 1.1 closed this for records and progress entries only. `listCategories()` and
 * `listGroups()` ended in `.filter(r => r.success)`, and `getSettings()` returned
 * `defaultSettings()` when the stored row failed to parse — so a corrupt category simply vanished,
 * and corrupt settings were replaced by defaults the user had never chosen, while the product went
 * on offering a "complete canonical backup".
 *
 * Every planted row below is synthetic: impossible dates, wrong types, missing discriminants. No
 * real data of any kind.
 */

let db: CivicWorkDeskDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = createDatabase(`civic-store-integrity-${String(counter)}`);
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

/** A category row whose `sortOrder` is a string — schema-invalid, structurally plausible. */
async function plantInvalidCategory(id = 'corrupt-category'): Promise<void> {
  await db.categories.put({
    id,
    name: '损坏的示范分类',
    sortOrder: 'not-a-number',
    builtIn: false,
    archived: false,
  } as never);
}

/** A group row missing `archived` entirely. */
async function plantInvalidGroup(id = 'corrupt-group'): Promise<void> {
  await db.groups.put({
    id,
    name: '损坏的示范分组',
    sortOrder: 0,
    builtIn: false,
  } as never);
}

/** Settings whose reminder interval is a string and whose option sets are the wrong shape. */
async function plantInvalidSettings(): Promise<void> {
  await db.settings.put({
    key: SETTINGS_KEY,
    value: {
      appTitle: '损坏的设置',
      appSubtitle: '',
      backupReminderDays: 'soon',
      options: { honorType: 'not-an-array', honorLevel: [], personalRole: [] },
    },
  } as never);
}

describe('REGRESSION: every user-data store reports its invalid rows', () => {
  it('detects an invalid category instead of silently dropping it', async () => {
    await createWorkRecord(workInput());
    await plantInvalidCategory();

    // The UI-facing read still hides it, which is correct — a corrupt row cannot be rendered.
    const visible = await listCategories();
    expect(visible.some((c) => c.id === 'corrupt-category')).toBe(false);

    // The integrity read must not.
    const snapshot = await readStoreSnapshot();
    expect(snapshot.invalid.categories).toHaveLength(1);
    expect(snapshot.invalid.categories[0]?.id).toBe('corrupt-category');
    expect(storeIsIntact(snapshot)).toBe(false);
  });

  it('detects an invalid group instead of silently dropping it', async () => {
    await plantInvalidGroup();
    const visible = await listGroups();
    expect(visible.some((g) => g.id === 'corrupt-group')).toBe(false);

    const snapshot = await readStoreSnapshot();
    expect(snapshot.invalid.groups).toHaveLength(1);
    expect(snapshot.invalid.groups[0]?.id).toBe('corrupt-group');
  });

  it('detects invalid settings instead of silently substituting defaults', async () => {
    await plantInvalidSettings();

    // `getSettings()` still falls back so the app stays usable...
    const usable = await getSettings();
    expect(usable.backupReminderDays).toBeTypeOf('number');

    // ...but the snapshot reports the corruption and refuses to call the stored value valid.
    const snapshot = await readStoreSnapshot();
    expect(snapshot.settings).toBeNull();
    expect(snapshot.invalid.settings).toHaveLength(1);
    expect(snapshot.invalid.settings[0]?.id).toBe(SETTINGS_ROW_ID);
    expect(storeIsIntact(snapshot)).toBe(false);
  });

  it('treats a missing settings row as an integrity problem, not as "no settings"', async () => {
    await db.settings.clear();
    const snapshot = await readStoreSnapshot();
    expect(snapshot.settings).toBeNull();
    expect(snapshot.invalid.settings[0]?.reason).toContain('缺失');
  });

  it('counts corruption across all five stores at once', async () => {
    await createWorkRecord(workInput());
    await db.records.put({ id: 'corrupt-record', kind: 'work', title: 1 } as never);
    await db.progressEntries.put({ id: 'corrupt-progress', recordId: 'x' } as never);
    await plantInvalidCategory();
    await plantInvalidGroup();
    await plantInvalidSettings();

    const snapshot = await readStoreSnapshot();
    expect(invalidRowCount(snapshot.invalid)).toBe(5);
    expect(snapshot.invalid.records).toHaveLength(1);
    expect(snapshot.invalid.progressEntries).toHaveLength(1);
    expect(snapshot.invalid.categories).toHaveLength(1);
    expect(snapshot.invalid.groups).toHaveLength(1);
    expect(snapshot.invalid.settings).toHaveLength(1);
  });
});

describe('REGRESSION: a corrupt taxonomy or settings row blocks a "complete" backup', () => {
  it('refuses a canonical backup when only a category is corrupt', async () => {
    await createWorkRecord(workInput());
    await plantInvalidCategory();

    const { createBackup } = await import('@/services/backup');
    await expect(createBackup()).rejects.toBeInstanceOf(IncompleteBackupError);
    try {
      await createBackup();
      expect.unreachable('createBackup must refuse');
    } catch (error) {
      expect((error as IncompleteBackupError).message).toContain('业务分类');
    }
  });

  it('refuses a canonical backup when only the settings row is corrupt', async () => {
    await createWorkRecord(workInput());
    await plantInvalidSettings();

    const { createBackup } = await import('@/services/backup');
    await expect(createBackup()).rejects.toBeInstanceOf(IncompleteBackupError);
  });

  it('an acknowledged export names every omitted row, including taxonomy and settings', async () => {
    await createWorkRecord(workInput());
    await plantInvalidCategory();
    await plantInvalidGroup();
    await plantInvalidSettings();

    const snapshot = await readBackupSnapshot();
    expect(snapshot.complete).toBe(false);
    const envelope = await buildEnvelope(snapshot.input, '2026-09-21T09:00:00.000Z');
    expect(envelope.completeness).toBe('incomplete');
    expect(envelope.omittedInvalidRowIds).toEqual([
      'corrupt-category',
      'corrupt-group',
      SETTINGS_ROW_ID,
    ]);
  });

  it('a clean store still produces a complete backup', async () => {
    await createWorkRecord(workInput());
    const snapshot = await readBackupSnapshot();
    expect(snapshot.complete).toBe(true);
    const envelope = await buildEnvelope(snapshot.input, '2026-09-21T09:00:00.000Z');
    expect(envelope.completeness).toBe('complete');
    expect(envelope.omittedInvalidRowIds).toEqual([]);
  });
});

describe('REGRESSION: the diagnostic recovery export preserves every store', () => {
  it('carries invalid categories, groups and settings verbatim with their reasons', async () => {
    await createWorkRecord(workInput({ title: '正常记录' }));
    await plantInvalidCategory();
    await plantInvalidGroup();
    await plantInvalidSettings();

    const recovery = await buildRecoveryExport('2026-09-21T09:00:00.000Z');

    expect(recovery.counts.invalidCategories).toBe(1);
    expect(recovery.counts.invalidGroups).toBe(1);
    expect(recovery.counts.invalidSettings).toBe(1);
    expect(recovery.counts.invalidTotal).toBe(3);

    const category = recovery.invalidCategories[0]?.raw as Record<string, unknown>;
    expect(category['sortOrder']).toBe('not-a-number');
    expect(recovery.invalidCategories[0]?.reason).toBeTruthy();

    const group = recovery.invalidGroups[0]?.raw as Record<string, unknown>;
    expect(group['name']).toBe('损坏的示范分组');
    expect(group['archived']).toBeUndefined();

    const settings = recovery.invalidSettings[0]?.raw as Record<string, unknown>;
    expect(settings['backupReminderDays']).toBe('soon');
    expect(settings['appTitle']).toBe('损坏的设置');

    // Context must not substitute defaults for the corrupt settings: that would hide the evidence.
    expect(recovery.context.settings).toBeNull();
    expect(recovery.rawChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('valid rows are still counted, so the file shows the damage in proportion', async () => {
    await createWorkRecord(workInput());
    await plantInvalidCategory();
    const recovery = await buildRecoveryExport('2026-09-21T09:00:00.000Z');
    expect(recovery.counts.validRecords).toBe(1);
    expect(recovery.counts.validCategories).toBeGreaterThan(0);
    expect(recovery.counts.validSettings).toBe(1);
  });
});

describe('REGRESSION: the canonical snapshot is one transaction', () => {
  it('reads every store inside a single read-only transaction', async () => {
    await createWorkRecord(workInput());

    /*
     * The property under test is the transaction boundary itself, so it is measured rather than
     * described: wrap `db.transaction` and record every scope it is asked for.
     *
     * Phase 1.1 built the snapshot from six independent repository reads issued through
     * `Promise.all`, each its own implicit transaction — this assertion sees **zero** explicit
     * transactions there and fails.
     */
    const scopes: string[][] = [];
    const original = db.transaction.bind(db) as unknown as (...args: unknown[]) => unknown;
    (db as unknown as { transaction: unknown }).transaction = (...args: unknown[]) => {
      const tables = args[1];
      const names = (Array.isArray(tables) ? tables : [tables]).map((table) =>
        String((table as { name?: string }).name ?? table),
      );
      scopes.push(names);
      return original(...args);
    };

    try {
      const snapshot = await readStoreSnapshot();
      expect(snapshot.records).toHaveLength(1);
    } finally {
      (db as unknown as { transaction: unknown }).transaction = original;
    }

    expect(scopes, 'the snapshot must open exactly one transaction').toHaveLength(1);
    expect([...(scopes[0] ?? [])].sort()).toEqual(
      ['categories', 'groups', 'meta', 'progressEntries', 'records', 'settings'].sort(),
    );
  });

  it('captures the revision from inside that transaction', async () => {
    await createWorkRecord(workInput());
    const snapshot = await readStoreSnapshot();
    const meta = await db.meta.get('app');
    expect(snapshot.capturedRevision).toBe(meta?.value.dataRevision);
    expect(snapshot.capturedRevision).toBeGreaterThan(0);
  });

  it('a snapshot of a clean store agrees with the repository reads it replaces', async () => {
    await createWorkRecord(workInput({ title: '甲' }));
    await createWorkRecord(workInput({ title: '乙' }));

    const snapshot = await readStoreSnapshot();
    const viaRepositories = await listRecords();
    expect(snapshot.records.map((r) => r.id).sort()).toEqual(
      viaRepositories.records.map((r) => r.id).sort(),
    );
    expect(snapshot.categories.map((c) => c.id)).toEqual((await listCategories()).map((c) => c.id));
    expect(snapshot.groups.map((g) => g.id)).toEqual((await listGroups()).map((g) => g.id));
  });
});
