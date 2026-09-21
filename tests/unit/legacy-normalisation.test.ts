import { describe, expect, it } from 'vitest';
import { isNormalisationFailure, normaliseLegacyRecord } from '@/services/import/legacy';
import type { NormalisedRecord } from '@/services/import/legacy';
import { anyRecordSchema } from '@/domain/validation';
import { BUILT_IN_CATEGORY_IDS, BUILT_IN_GROUP_IDS, guessCategoryId } from '@/domain/defaults';
import { isWorkRecord } from '@/domain/types';
import type { HonorRecord, WorkRecord } from '@/domain/types';
import { LEGACY_EDGE_CASES } from '../fixtures/legacy-backups';
import type { LegacyRecordShape } from '../fixtures/legacy-backups';

function normalise(input: LegacyRecordShape, index = 0): NormalisedRecord {
  const outcome = normaliseLegacyRecord(input, index);
  if (isNormalisationFailure(outcome)) {
    throw new Error(`expected success, got failure: ${outcome.reason}`);
  }
  return outcome;
}

function byId(id: string): LegacyRecordShape {
  const found = LEGACY_EDGE_CASES.find((record) => record.id === id);
  if (!found) throw new Error(`fixture ${id} is missing`);
  return found;
}

function asWork(result: NormalisedRecord): WorkRecord {
  if (!isWorkRecord(result.record)) throw new Error('expected a work record');
  return result.record;
}

function asHonor(result: NormalisedRecord): HonorRecord {
  if (result.record.kind !== 'honor') throw new Error('expected an honour record');
  return result.record;
}

describe('every normalised record satisfies the domain schema', () => {
  it('validates all fixtures that are not deliberately rejected', () => {
    for (const [index, fixture] of LEGACY_EDGE_CASES.entries()) {
      const outcome = normaliseLegacyRecord(fixture, index);
      if (isNormalisationFailure(outcome)) {
        // Only the untitled fixture is expected to fail.
        expect(fixture.id).toBe('fix_019');
        continue;
      }
      const parsed = anyRecordSchema.safeParse(outcome.record);
      expect(
        parsed.success,
        `${String(fixture.id)}: ${JSON.stringify(parsed.error?.issues[0])}`,
      ).toBe(true);
    }
  });
});

describe('dates', () => {
  it('keeps a clean ISO date structured', () => {
    const work = asWork(normalise(byId('fix_001')));
    expect(work.occurredOn).toEqual({ kind: 'plain', date: '2026-01-04' });
    expect(work.completedOn).toEqual({ kind: 'plain', date: '2026-01-09' });
  });

  it('preserves a month-only date as text and warns', () => {
    const result = normalise(byId('fix_002'));
    expect(asWork(result).occurredOn).toEqual({ kind: 'text', text: '1月' });
    const warning = result.warnings.find((w) => w.field === 'date');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('year');
  });

  it('preserves an impossible date without shifting it', () => {
    const work = asWork(normalise(byId('fix_016')));
    expect(work.occurredOn).toEqual({ kind: 'text', text: '2026-02-30' });
  });

  it('normalises a slash date and reports the rewrite as info, not a warning', () => {
    const result = normalise(byId('fix_020'));
    expect(asWork(result).occurredOn).toEqual({ kind: 'plain', date: '2026-09-07' });
    const warning = result.warnings.find((w) => w.field === 'date');
    expect(warning?.severity).toBe('info');
  });

  it('treats deliberate free text (deadlineType=text) as info, not a defect', () => {
    const result = normalise(byId('fix_004'));
    const work = asWork(result);
    expect(work.reportDeadline).toEqual({ kind: 'text', text: '待定（4月前）' });
    expect(result.warnings.find((w) => w.field === 'reportDeadline')?.severity).toBe('info');
    // Completion time was free text too; it survives intact.
    expect(work.completedOn).toEqual({ kind: 'text', text: '5月13日上传' });
  });

  it('parses the VALUE even when the legacy type discriminator disagrees with it', () => {
    // fix_005 has deadlineType:'date' with free text in the value.
    const result = normalise(byId('fix_005'));
    expect(asWork(result).reportDeadline).toEqual({ kind: 'text', text: '3月5日12时前' });
    expect(result.warnings.find((w) => w.field === 'reportDeadline')?.severity).toBe('warning');
  });

  it('reads a populated `due` even though `dueType` is empty', () => {
    // The legacy `normalizeRecord()` defaulted `dueType` to 'none' when falsy, which would have
    // discarded this deadline entirely.
    const work = asWork(normalise(byId('fix_006')));
    expect(work.completionDeadline).toEqual({ kind: 'plain', date: '2026-03-20' });
    expect(work.reportDeadline).toEqual({ kind: 'plain', date: '2026-03-31' });
  });
});

describe('contact values', () => {
  it('keeps a spreadsheet-derived landline unchanged and raises a data-quality warning', () => {
    const result = normalise(byId('fix_007'));
    expect(asWork(result).counterpartPhone).toBe('82393933.0');
    const warning = result.warnings.find((w) => w.field === 'counterpartPhone');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('left unchanged');
  });

  it('keeps a multi-line contact field intact and says so', () => {
    const result = normalise(byId('fix_008'));
    expect(asWork(result).counterpartPhone).toBe('656430\n673679');
    expect(result.warnings.some((w) => w.field === 'counterpartPhone')).toBe(true);
  });

  it('stores a numeric phone as a string and warns about lost leading zeroes', () => {
    const result = normalise(byId('fix_009'));
    const work = asWork(result);
    expect(work.counterpartPhone).toBe('13800130003');
    expect(typeof work.counterpartPhone).toBe('string');
    expect(result.warnings.find((w) => w.field === 'counterpartPhone')?.message).toContain(
      'leading zeroes',
    );
  });
});

describe('status', () => {
  it('maps 未完成 to todo and keeps the original wording', () => {
    const work = asWork(normalise(byId('fix_010')));
    expect(work.status).toBe('todo');
    expect(work.statusLabel).toBe('未完成');
  });

  it('lets completion win over the long-term flag', () => {
    const work = asWork(normalise(byId('fix_011')));
    expect(work.status).toBe('completed');
    expect(work.longTerm).toBe(true);
    expect(work.groupId).toBe(BUILT_IN_GROUP_IDS.longTerm);
  });

  it('falls back to todo for unknown wording, preserves it, and warns', () => {
    const result = normalise(byId('fix_012'));
    const work = asWork(result);
    expect(work.status).toBe('todo');
    expect(work.statusLabel).toBe('基本完成（待复核）');
    const warning = result.warnings.find((w) => w.field === 'status');
    expect(warning?.severity).toBe('warning');
  });
});

describe('progress entries', () => {
  it('gives every entry a stable id and drops only the empty ones, with a warning', () => {
    const result = normalise(byId('fix_013'));
    expect(result.progress).toHaveLength(3);
    expect(new Set(result.progress.map((entry) => entry.id)).size).toBe(3);
    for (const entry of result.progress) {
      expect(entry.recordId).toBe(result.record.id);
      expect(entry.note.trim()).not.toBe('');
    }
    expect(result.progress[0]?.occurredOn).toEqual({ kind: 'plain', date: '2026-07-02' });
    expect(result.progress[1]?.occurredOn).toEqual({ kind: 'absent' });
    expect(result.progress[2]?.note).toBe('纯文本形式的进展条目');
    expect(result.warnings.find((w) => w.field === 'progress')?.message).toContain('1 progress');
  });
});

describe('honours', () => {
  it('maps the current honour shape onto honour fields', () => {
    const honor = asHonor(normalise(byId('fix_014')));
    expect(honor.kind).toBe('honor');
    expect(honor.honorType).toBe('感谢信');
    expect(honor.level).toBe('省级');
    expect(honor.issuingOrg).toBe('示范上级机关');
    expect(honor.documentNo).toBe('示范函〔2026〕1号');
    expect(honor.personalRole).toBe('主要承办人');
    expect(honor.evidenceLocation).toBe('原件存档案柜示范号盒');
    expect(honor.awardedOn).toEqual({ kind: 'plain', date: '2026-03-15' });
  });

  it('upgrades the oldest honour shape (name/type/level/from/no/role/evidence)', () => {
    const honor = asHonor(normalise(byId('fix_015')));
    expect(honor.title).toBe('示范先进集体');
    expect(honor.honorType).toBe('表彰（先进集体/个人）');
    expect(honor.level).toBe('市级');
    expect(honor.issuingOrg).toBe('示范人民政府');
    expect(honor.documentNo).toBe('示范发〔2026〕2号');
    expect(honor.personalRole).toBe('集体荣誉');
    expect(honor.evidenceLocation).toBe('奖牌存展示柜');
  });
});

describe('categories and residue', () => {
  it('maps a known legacy category name onto its stable id', () => {
    expect(asWork(normalise(byId('fix_001'))).categoryId).toBe(
      BUILT_IN_CATEGORY_IDS.appraisalAndFiling,
    );
  });

  it('leaves an unknown category name uncategorised, warns, and does not invent one', () => {
    const result = normalise(byId('fix_017'));
    const work = asWork(result);
    const warning = result.warnings.find((w) => w.field === 'categoryId');
    expect(warning).toBeDefined();
    // The keyword guesser may still assign one from the title; what must not happen is silently
    // adopting the unknown name or falling back to the LAST category, as the legacy code did.
    expect(work.categoryId).toBe(guessCategoryId('分类名称未知的示范事项'));
  });

  it('preserves an unrecognised field in legacyResidue and warns', () => {
    const result = normalise(byId('fix_018'));
    const work = asWork(result);
    expect(work.legacyResidue).toEqual({ customLegacyField: '这个值在新模型中没有对应字段' });
    expect(result.warnings.some((w) => w.field.includes('customLegacyField'))).toBe(true);
  });
});

describe('rejection and identity', () => {
  it('rejects only a row with no usable title', () => {
    const outcome = normaliseLegacyRecord(byId('fix_019'), 18);
    expect(isNormalisationFailure(outcome)).toBe(true);
  });

  it('rejects a non-object row', () => {
    expect(isNormalisationFailure(normaliseLegacyRecord('not an object', 0))).toBe(true);
    expect(isNormalisationFailure(normaliseLegacyRecord(null, 0))).toBe(true);
    expect(isNormalisationFailure(normaliseLegacyRecord([1, 2], 0))).toBe(true);
  });

  it('preserves the legacy id so re-importing the same backup is idempotent', () => {
    expect(normalise(byId('fix_001')).record.id).toBe('fix_001');
  });

  it('mints an id when the source has none', () => {
    const result = normalise({ title: '没有 ID 的记录' });
    expect(result.record.id).toMatch(/^test-id-/);
  });

  it('ignores a legacy createdAt that is not a usable instant', () => {
    // Legacy `createdAt` was `new Date(r.date).getTime()`, i.e. NaN for a free-text date.
    const result = normalise({ title: '示范', createdAt: Number.NaN });
    expect(result.record.createdAt).toBe('2026-09-21T09:00:00.000Z');
  });

  it('adopts a plausible legacy createdAt', () => {
    const result = normalise({ title: '示范', createdAt: Date.UTC(2026, 0, 4) });
    expect(result.record.createdAt).toBe('2026-01-04T00:00:00.000Z');
  });
});
