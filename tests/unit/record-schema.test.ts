import { describe, expect, it } from 'vitest';
import { honorRecordSchema, workRecordSchema, workRecordSchemaV1 } from '@/domain/validation';
import { makeHonor, makeWork } from '../fixtures/records';

/**
 * The record schemas at the Phase-5 boundary.
 *
 * `parentWorkId` is required-but-nullable on a stored v2 work record, forbidden on a schema-1 work
 * record, and forbidden on an honour — each rejection rather than a silent strip, because stripping is
 * how a damaged row comes to look clean.
 */

describe('work record, schema 2', () => {
  it('accepts a top-level task and a sub-task', () => {
    expect(workRecordSchema.safeParse(makeWork({ parentWorkId: null })).success).toBe(true);
    expect(workRecordSchema.safeParse(makeWork({ parentWorkId: 'parent-1' })).success).toBe(true);
  });

  it('rejects a row the v1 → v2 migration never reached', () => {
    const row: Record<string, unknown> = { ...makeWork() };
    delete row['parentWorkId'];
    expect(workRecordSchema.safeParse(row).success).toBe(false);
  });

  it('rejects an empty parent id', () => {
    expect(workRecordSchema.safeParse({ ...makeWork(), parentWorkId: '' }).success).toBe(false);
  });
});

describe('work record, schema 1', () => {
  it('accepts the pre-Phase-5 shape and refuses a parent it could not have written', () => {
    const row: Record<string, unknown> = { ...makeWork() };
    delete row['parentWorkId'];
    expect(workRecordSchemaV1.safeParse(row).success).toBe(true);
    expect(workRecordSchemaV1.safeParse({ ...row, parentWorkId: 'x' }).success).toBe(false);
    expect(workRecordSchemaV1.safeParse({ ...row, parentWorkId: null }).success).toBe(false);
  });
});

describe('honour record', () => {
  it('never takes part in the hierarchy: the key is rejected, not stripped', () => {
    expect(honorRecordSchema.safeParse(makeHonor()).success).toBe(true);
    expect(honorRecordSchema.safeParse({ ...makeHonor(), parentWorkId: 'w-1' }).success).toBe(
      false,
    );
    expect(honorRecordSchema.safeParse({ ...makeHonor(), parentWorkId: null }).success).toBe(false);
  });
});
