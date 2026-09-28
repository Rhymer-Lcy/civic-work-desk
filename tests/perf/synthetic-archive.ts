import { defaultCategories, defaultGroups } from '@/domain/defaults';
import { WORK_STATUSES } from '@/domain/status';
import type { DateValue } from '@/domain/dates';
import type { AnyRecord, HonorRecord, ProgressEntry, WorkRecord } from '@/domain/types';

/**
 * A deterministic synthetic archive for scale measurements.
 *
 * Fictional throughout: titles are assembled from a small vocabulary of generic office phrases and a
 * running number, units are 示范单位甲…, and no value is taken from any real record. The same seed
 * always yields the same archive, so a measurement taken before a change and one taken after it
 * describe the same data.
 *
 * The shape is chosen to resemble a heavy personal archive rather than a uniform grid: dates spread
 * over three years with a share of free-text and ranged values, a status mix weighted towards
 * completed work, most records categorised, one honour for every ten work records, and progress
 * notes on roughly a third of the work.
 */

export interface SyntheticArchive {
  readonly records: AnyRecord[];
  readonly progressEntries: ProgressEntry[];
}

export interface SyntheticOptions {
  readonly workCount: number;
  readonly seed?: number;
}

/** mulberry32: small, fast, and reproducible across engines. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['报送', '起草', '协调', '整理', '审核', '筹备', '反馈', '汇总', '落实', '跟进'];
const OBJECTS = [
  '工作要点',
  '情况报告',
  '会议材料',
  '年度计划',
  '意见建议',
  '统计报表',
  '接待方案',
];
const UNITS = ['示范单位甲', '示范单位乙', '示范单位丙', '示范单位丁', '示范单位戊', ''];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function isoDay(random: () => number): string {
  const year = 2024 + Math.floor(random() * 3);
  const month = 1 + Math.floor(random() * 12);
  const day = 1 + Math.floor(random() * 28);
  return `${String(year)}-${pad(month)}-${pad(day)}`;
}

function dateValue(random: () => number): DateValue {
  const roll = random();
  if (roll < 0.8) return { kind: 'plain', date: isoDay(random) };
  if (roll < 0.9) {
    const a = isoDay(random);
    const b = isoDay(random);
    return a <= b ? { kind: 'range', start: a, end: b } : { kind: 'range', start: b, end: a };
  }
  if (roll < 0.95) return { kind: 'text', text: '待定（月底前）' };
  return { kind: 'absent' };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  const item = list[Math.floor(random() * list.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

export function buildSyntheticArchive(options: SyntheticOptions): SyntheticArchive {
  const random = prng(options.seed ?? 20260928);
  const categories = defaultCategories();
  const groups = defaultGroups();
  const stamp = '2026-09-01T00:00:00.000Z';
  const records: AnyRecord[] = [];
  const progressEntries: ProgressEntry[] = [];

  for (let index = 0; index < options.workCount; index += 1) {
    const statusRoll = random();
    const status =
      statusRoll < 0.55
        ? 'completed'
        : (WORK_STATUSES[Math.floor(random() * WORK_STATUSES.length)] ?? 'todo');
    const id = `syn-work-${pad(index, 5)}`;
    const work: WorkRecord = {
      id,
      kind: 'work',
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: random() < 0.02 ? stamp : null,
      title: `${pick(random, VERBS)}${pick(random, OBJECTS)}（第${String(index + 1)}项）`,
      occurredOn: dateValue(random),
      status,
      statusLabel: '',
      requirement: random() < 0.5 ? '按时上报书面材料' : '',
      reportDeadline: random() < 0.6 ? dateValue(random) : { kind: 'absent' },
      completionDeadline: random() < 0.4 ? dateValue(random) : { kind: 'absent' },
      completedOn: status === 'completed' ? dateValue(random) : { kind: 'absent' },
      categoryId: random() < 0.85 ? pick(random, categories).id : null,
      groupId: random() < 0.3 ? pick(random, groups).id : null,
      longTerm: random() < 0.08,
      counterpartUnit: pick(random, UNITS),
      counterpartContact: random() < 0.4 ? '联系人甲' : '',
      counterpartPhone: random() < 0.3 ? '010-00000000' : '',
      remark: random() < 0.3 ? '备注：示范文字，用于测量检索与渲染开销。' : '',
      legacyResidue: null,
    };
    records.push(work);

    if (random() < 0.33) {
      const notes = 1 + Math.floor(random() * 3);
      for (let n = 0; n < notes; n += 1) {
        progressEntries.push({
          id: `syn-progress-${pad(index, 5)}-${String(n)}`,
          recordId: id,
          occurredOn: dateValue(random),
          note: `进展说明第${String(n + 1)}条`,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
    }

    if (index % 10 === 0) {
      const honor: HonorRecord = {
        id: `syn-honor-${pad(index, 5)}`,
        kind: 'honor',
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
        title: `示范表彰（第${String(index / 10 + 1)}项）`,
        awardedOn: dateValue(random),
        honorType: '表彰',
        level: pick(random, ['省级', '市级', '区级']),
        issuingOrg: pick(random, UNITS),
        documentNo: '',
        personalRole: '',
        evidenceLocation: '',
        relatedWorkId: random() < 0.3 ? id : null,
        remark: '',
        legacyResidue: null,
      };
      records.push(honor);
    }
  }

  return { records, progressEntries };
}
