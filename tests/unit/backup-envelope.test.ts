import { describe, expect, it } from 'vitest';
import {
  BACKUP_APP_ID,
  BACKUP_FORMAT_VERSION,
  backupEnvelopeSchema,
  backupFilename,
  buildEnvelope,
  canonicalJson,
  countEntities,
  countsAreConsistent,
  serialiseEnvelope,
  sha256Hex,
  verifyChecksum,
} from '@/services/backup/envelope';
import { assessBackupHealth } from '@/services/backup';
import { defaultCategories, defaultGroups, defaultSettings } from '@/domain/defaults';
import { SCHEMA_VERSION } from '@/db/schema';
import { makeHonor, makeProgress, makeWork } from '../fixtures/records';

function sample() {
  const work = makeWork({ id: 'w1' });
  return {
    records: [work, makeHonor({ id: 'h1' })],
    progressEntries: [makeProgress('w1', '示范进展')],
    categories: defaultCategories(),
    groups: defaultGroups(),
    settings: defaultSettings(),
  };
}

describe('canonical JSON', () => {
  it('sorts object keys so the digest does not depend on assignment order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('preserves array order, which carries meaning', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('handles nesting, nulls and dropped undefined values', () => {
    expect(canonicalJson({ z: null, a: { d: 1, c: [{ y: 1, x: 2 }] } })).toBe(
      '{"a":{"c":[{"x":2,"y":1}],"d":1},"z":null}',
    );
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });
});

describe('envelope', () => {
  it('is self-describing and validates against its own schema', async () => {
    const envelope = await buildEnvelope(sample(), '2026-09-21T09:00:00.000Z');
    expect(envelope.application).toBe(BACKUP_APP_ID);
    expect(envelope.backupFormatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.exportedAt).toBe('2026-09-21T09:00:00.000Z');
    expect(backupEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('counts each entity kind', () => {
    const counts = countEntities(sample());
    expect(counts).toEqual({
      records: 2,
      workRecords: 1,
      honorRecords: 1,
      progressEntries: 1,
      categories: 12,
      groups: 3,
    });
  });

  it('round-trips through JSON without loss', async () => {
    const envelope = await buildEnvelope(sample(), '2026-09-21T09:00:00.000Z');
    const text = serialiseEnvelope(envelope);
    expect(text.endsWith('\n')).toBe(true);
    const parsed: unknown = JSON.parse(text);
    const revalidated = backupEnvelopeSchema.safeParse(parsed);
    expect(revalidated.success).toBe(true);
    expect(canonicalJson(revalidated.success ? revalidated.data : null)).toBe(
      canonicalJson(envelope),
    );
  });

  it('verifies its own checksum', async () => {
    const envelope = await buildEnvelope(sample(), '2026-09-21T09:00:00.000Z');
    expect(envelope.payloadChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyChecksum(envelope)).toBe('match');
  });

  it('detects a payload tampered with after export', async () => {
    const envelope = await buildEnvelope(sample(), '2026-09-21T09:00:00.000Z');
    const tampered = structuredClone(envelope);
    const first = tampered.payload.records[0];
    expect(first).toBeDefined();
    if (first) first.title = '被改动过的标题';
    expect(await verifyChecksum(tampered)).toBe('mismatch');
  });

  it('reports an absent checksum without treating it as corruption', async () => {
    const envelope = await buildEnvelope(sample(), '2026-09-21T09:00:00.000Z');
    expect(await verifyChecksum({ ...envelope, payloadChecksum: null })).toBe('absent');
  });

  it('detects declared counts that disagree with the payload', async () => {
    const envelope = await buildEnvelope(sample(), '2026-09-21T09:00:00.000Z');
    expect(countsAreConsistent(envelope)).toBe(true);
    expect(countsAreConsistent({ ...envelope, counts: { ...envelope.counts, records: 99 } })).toBe(
      false,
    );
  });

  it('rejects an envelope whose records fail the domain schema', () => {
    const broken = {
      application: BACKUP_APP_ID,
      backupFormatVersion: 1,
      schemaVersion: 1,
      exportedAt: '2026-09-21T09:00:00.000Z',
      counts: {
        records: 1,
        workRecords: 1,
        honorRecords: 0,
        progressEntries: 0,
        categories: 0,
        groups: 0,
      },
      payloadChecksum: null,
      payload: {
        records: [{ id: 'x', kind: 'work' }],
        progressEntries: [],
        categories: [],
        groups: [],
        settings: defaultSettings(),
      },
    };
    expect(backupEnvelopeSchema.safeParse(broken).success).toBe(false);
  });

  it('produces a deterministic, sortable filename', () => {
    expect(backupFilename('20260921-143052')).toBe('civic-work-desk-backup-20260921-143052.json');
    // Lexical order matches chronological order.
    const names = ['20260921-143052', '20260101-000000', '20261231-235959'].map(backupFilename);
    expect([...names].sort()).toEqual([names[1], names[0], names[2]]);
  });

  it('hashes deterministically', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('backup health', () => {
  const settings = defaultSettings();

  /**
   * `dataRevision` is the live counter; `lastBackupRevision` is what the last backup captured.
   * Equal means the stored data is exactly what was backed up.
   */
  const meta = (
    lastBackupAt: string | null,
    count: number | null,
    dataRevision = 0,
    lastBackupRevision: number | null = dataRevision,
  ) => ({
    schemaVersion: 1,
    dataRevision,
    lastBackupAt,
    lastBackupRevision,
    lastBackupRecordCount: count,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('never nags about an empty store', () => {
    // The legacy fix for this noise was to hard-hide the banner on every load, which disabled the
    // warning permanently. Suppressing it only when there is nothing to lose is the correct rule.
    expect(assessBackupHealth(meta(null, null), 0, 7, '2026-09-21').state).toBe('fresh');
  });

  it('reports never-backed-up when records exist', () => {
    expect(assessBackupHealth(meta(null, null), 5, 7, '2026-09-21').state).toBe('never');
  });

  it('is fresh while the data has not changed since the backup', () => {
    const health = assessBackupHealth(meta('2026-09-19T00:00:00Z', 5, 11), 5, 7, '2026-09-21');
    expect(health.state).toBe('fresh');
  });

  it('REGRESSION: an edit that leaves the record count unchanged marks the backup stale', () => {
    // Phase 1 compared age and record count only, so editing an existing record left the backup
    // looking current. The revision counter makes any mutation detectable.
    const afterEdit = meta('2026-09-21T00:00:00Z', 5, /* dataRevision */ 12, /* captured */ 11);
    const health = assessBackupHealth(afterEdit, 5, 7, '2026-09-21');
    expect(health.state).toBe('stale');
    expect(health.state === 'stale' && health.reason).toBe('data-changed');
  });

  it('goes stale on age even when the data is unchanged', () => {
    const health = assessBackupHealth(meta('2026-09-10T00:00:00Z', 5, 11), 5, 7, '2026-09-21');
    expect(health.state).toBe('stale');
    expect(health.state === 'stale' && health.reason).toBe('age');
  });

  it('treats a missing captured revision as diverged rather than assuming freshness', () => {
    const legacyMeta = meta('2026-09-21T00:00:00Z', 5, 3, null);
    expect(assessBackupHealth(legacyMeta, 5, 7, '2026-09-21').state).toBe('stale');
  });

  it('reports unknown rather than guessing when meta is missing or unreadable', () => {
    expect(assessBackupHealth(null, 5, 7, '2026-09-21').state).toBe('unknown');
    expect(assessBackupHealth(meta('not-a-date', 1, 0), 5, 7, '2026-09-21').state).toBe('unknown');
  });

  it('uses the configured reminder interval for the age rule', () => {
    expect(
      assessBackupHealth(
        meta('2026-09-19T00:00:00Z', 5, 4),
        5,
        settings.backupReminderDays,
        '2026-09-21',
      ).state,
    ).toBe('fresh');
    expect(assessBackupHealth(meta('2026-09-19T00:00:00Z', 5, 4), 5, 1, '2026-09-21').state).toBe(
      'stale',
    );
  });
});
