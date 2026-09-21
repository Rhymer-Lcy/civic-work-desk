import { describe, expect, it } from 'vitest';
import type { AnyRecord } from '@/domain/types';
import { defaultCategories, defaultGroups, defaultSettings } from '@/domain/defaults';
import { buildEnvelope } from '@/services/backup/envelope';
import { buildImportPlan, recordSignature } from '@/services/import/plan';
import { makeHonor, makeWork, plain, range } from '../fixtures/records';

/**
 * Record content signatures.
 *
 * The signature decides whether an ID clash is a harmless duplicate ("内容相同，跳过无影响") or a
 * genuine divergence the user must be told about. Phase 1 computed it with a JSON replacer array,
 * which filters property names at *every* depth — so nested keys were dropped and records differing
 * only in their dates compared equal.
 *
 * `phase1Signature` below is the defective implementation, kept verbatim so each assertion states
 * what actually regressed rather than merely testing the current code against itself.
 */
function phase1Signature(record: AnyRecord): string {
  const rest: Record<string, unknown> = { ...record };
  delete rest['updatedAt'];
  delete rest['createdAt'];
  return JSON.stringify(rest, Object.keys(rest).sort());
}

describe('recordSignature', () => {
  it('REGRESSION: a different occurrence date is a different record', () => {
    const a = makeWork({ id: 'w1', occurredOn: plain('2026-09-01') });
    const b = makeWork({ id: 'w1', occurredOn: plain('2026-09-30') });

    expect(recordSignature(a)).not.toBe(recordSignature(b));
    // The defect this test exists for: `date` is not a top-level record key, so the replacer
    // array dropped it at depth 1 and both records serialised to the same string.
    expect(phase1Signature(a)).toBe(phase1Signature(b));
  });

  it('REGRESSION: both ends of a date range participate in the signature', () => {
    const base = makeWork({ id: 'w1' });
    const q3 = { ...base, occurredOn: range('2026-07-01', '2026-09-30') };
    const q4 = { ...base, occurredOn: range('2026-10-01', '2026-12-31') };
    const sameStart = { ...base, occurredOn: range('2026-07-01', '2026-08-31') };

    expect(recordSignature(q3)).not.toBe(recordSignature(q4));
    expect(recordSignature(q3)).not.toBe(recordSignature(sameStart));
    expect(phase1Signature(q3)).toBe(phase1Signature(q4));
  });

  it('REGRESSION: free-text dates are compared by their text', () => {
    const base = makeWork({ id: 'w1' });
    const a = { ...base, occurredOn: { kind: 'text', text: '第三季度' } as const };
    const b = { ...base, occurredOn: { kind: 'text', text: '第四季度' } as const };

    expect(recordSignature(a)).not.toBe(recordSignature(b));
    expect(phase1Signature(a)).toBe(phase1Signature(b));
  });

  it('REGRESSION: preserved legacy residue participates in the signature', () => {
    const base = makeWork({ id: 'w1' });
    const a = { ...base, legacyResidue: { 原始栏位: '甲' } };
    const b = { ...base, legacyResidue: { 原始栏位: '乙' } };
    const none = { ...base, legacyResidue: null };

    expect(recordSignature(a)).not.toBe(recordSignature(b));
    expect(recordSignature(a)).not.toBe(recordSignature(none));
    // Residue is a free-form map, so *every* one of its keys was invisible to the old signature.
    expect(phase1Signature(a)).toBe(phase1Signature(b));
  });

  it('REGRESSION: an honour award date participates in the signature', () => {
    const a = makeHonor({ id: 'h1', awardedOn: plain('2026-06-20') });
    const b = makeHonor({ id: 'h1', awardedOn: plain('2025-06-20') });

    expect(recordSignature(a)).not.toBe(recordSignature(b));
    expect(phase1Signature(a)).toBe(phase1Signature(b));
  });

  it('ignores audit timestamps, which are not content', () => {
    const a = makeWork({ id: 'w1', createdAt: '2026-01-01T00:00:00.000Z' });
    const b = makeWork({
      id: 'w1',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T10:00:00.000Z',
    });

    expect(recordSignature(a)).toBe(recordSignature(b));
  });

  it('does not depend on property assignment order at any depth', () => {
    const a = makeWork({
      id: 'w1',
      occurredOn: { kind: 'range', start: '2026-01-01', end: '2026-03-31' },
    });
    const reordered = {
      ...makeWork({ id: 'w1' }),
      occurredOn: { end: '2026-03-31', start: '2026-01-01', kind: 'range' },
    } as unknown as AnyRecord;

    expect(recordSignature(a)).toBe(recordSignature(reordered));
  });

  it('separates a work record from an honour record of the same title', () => {
    const work = makeWork({ id: 'x1', title: '同名条目' });
    const honor = makeHonor({ id: 'x1', title: '同名条目' });

    expect(recordSignature(work)).not.toBe(recordSignature(honor));
  });
});

describe('import preview uses the corrected signature', () => {
  async function envelopeOf(records: readonly AnyRecord[]) {
    return buildEnvelope(
      {
        records: [...records],
        progressEntries: [],
        categories: defaultCategories(),
        groups: defaultGroups(),
        settings: defaultSettings(),
      },
      '2026-09-21T09:00:00.000Z',
    );
  }

  it('REGRESSION: an ID clash differing only in its date is NOT reported as identical', async () => {
    const stored = makeWork({ id: 'w1', occurredOn: plain('2026-09-01') });
    const incoming = makeWork({ id: 'w1', occurredOn: plain('2026-09-30') });

    const plan = await buildImportPlan({
      parsed: await envelopeOf([incoming]),
      mode: 'merge',
      existing: [stored],
    });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.identical).toBe(false);
    expect(plan.summary.identicalConflicts).toBe(0);
    // The stored row is kept either way; what changes is that the user is told they differ.
    expect(plan.accepted).toHaveLength(0);
  });

  it('a true duplicate still reads as identical, so merge stays quiet about it', async () => {
    const stored = makeWork({ id: 'w1', occurredOn: plain('2026-09-01') });
    const sameContentLaterEdit = { ...stored, updatedAt: '2026-09-21T10:00:00.000Z' };

    const plan = await buildImportPlan({
      parsed: await envelopeOf([sameContentLaterEdit]),
      mode: 'merge',
      existing: [stored],
    });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.identical).toBe(true);
    expect(plan.summary.identicalConflicts).toBe(1);
  });
});
