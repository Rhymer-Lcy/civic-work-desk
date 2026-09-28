import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { defaultCategories } from '@/domain/defaults';
import { monthPeriod, summarise } from '@/domain/reports';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord, HonorRecord } from '@/domain/types';
import { buildPeriodReport } from '@/services/export/docx';
import { buildWorkbook } from '@/services/export/xlsx';
import { makeHonor, makeWork, plain } from '../fixtures/records';

/**
 * The hierarchy in the reports (docs/phase-5-product-evolution.md §9).
 *
 * Fixture: one root, two children with the **same title** in different branches, a grandchild, a mix
 * of open and completed work, and an overdue descendant. Every path is asserted by following ids, and
 * the exports are read back from the bytes they produced, not from the objects that built them.
 */

const TODAY = '2026-09-20';

function archive(): AnyRecord[] {
  return [
    makeWork({ id: 'root', title: '筹备示范会议', occurredOn: plain('2026-08-25') }),
    makeWork({
      id: 'a',
      title: '起草材料',
      parentWorkId: 'root',
      occurredOn: plain('2026-09-02'),
      status: 'completed',
    }),
    makeWork({ id: 'other', title: '另一个一级任务', occurredOn: plain('2026-09-03') }),
    makeWork({
      id: 'b',
      title: '起草材料',
      parentWorkId: 'other',
      occurredOn: plain('2026-09-04'),
    }),
    makeWork({
      id: 'grand',
      title: '汇总各单位意见',
      parentWorkId: 'a',
      occurredOn: plain('2026-09-05'),
      reportDeadline: plain('2026-09-10'),
    }),
    makeHonor({
      id: 'h',
      title: '示范表彰',
      relatedWorkId: 'root',
      awardedOn: plain('2026-09-06'),
    }),
  ];
}

/** A cell as text: this export writes strings and dates, and anything else is shown as JSON. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

async function readSheet(blob: Blob, name: string): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await blob.arrayBuffer());
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`no sheet ${name}`);
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, column) => {
    headers[column - 1] = cellText(cell.value);
  });
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const out: Record<string, string> = {};
    headers.forEach((header, index) => {
      out[header] = cellText(row.getCell(index + 1).value);
    });
    rows.push(out);
  });
  return rows;
}

describe('XLSX', () => {
  it('adds level, parent, path and both ids, resolved by id through duplicate titles', async () => {
    const records = archive();
    const blob = await buildWorkbook({
      records,
      context: records,
      categories: defaultCategories(),
      groups: [],
      today: TODAY,
      generatedAt: '2026-09-20T00:00:00.000Z',
    });
    const rows = await readSheet(blob, '日常工作');
    const byId = new Map(rows.map((row) => [row['记录ID'], row]));
    expect(byId.size).toBe(5);

    expect(byId.get('root')).toMatchObject({
      任务层级: '1级任务',
      上级任务: '',
      任务路径: '筹备示范会议',
      上级记录ID: '',
    });
    expect(byId.get('grand')).toMatchObject({
      任务层级: '3级子任务',
      上级任务: '起草材料',
      任务路径: '筹备示范会议 / 起草材料 / 汇总各单位意见',
      上级记录ID: 'a',
    });
    // Two 起草材料 rows, told apart by their paths and parent ids.
    expect(byId.get('a')?.['任务路径']).toBe('筹备示范会议 / 起草材料');
    expect(byId.get('b')?.['任务路径']).toBe('另一个一级任务 / 起草材料');
    expect(byId.get('b')?.['上级记录ID']).toBe('other');
  });

  it('keeps the full path when the filter shows only the sub-task', async () => {
    const records = archive();
    const onlyGrandchild = records.filter((record) => record.id === 'grand');
    const blob = await buildWorkbook({
      records: onlyGrandchild,
      context: records,
      categories: [],
      groups: [],
      today: TODAY,
      generatedAt: '2026-09-20T00:00:00.000Z',
    });
    const [row] = await readSheet(blob, '日常工作');
    expect(row?.['任务路径']).toBe('筹备示范会议 / 起草材料 / 汇总各单位意见');
  });

  it('names a linked work item that is only filtered out, instead of calling it deleted', async () => {
    const records = archive();
    const honorOnly = records.filter((record): record is HonorRecord => record.kind === 'honor');
    const blob = await buildWorkbook({
      records: honorOnly,
      context: records,
      categories: [],
      groups: [],
      today: TODAY,
      generatedAt: '2026-09-20T00:00:00.000Z',
    });
    const [row] = await readSheet(blob, '荣誉表彰');
    expect(row?.['关联工作事项']).toBe('筹备示范会议');
  });
});

describe('DOCX period report', () => {
  it('lists each sub-task by its own date, with its level and parents on a second line', async () => {
    const records = archive();
    const period = monthPeriod(2026, 9);
    // The root is dated in August: outside the period, but its September sub-tasks are not omitted.
    const work = records.filter(isWorkRecord).filter((record) => record.id !== 'root');
    const honors = records.filter((record): record is HonorRecord => record.kind === 'honor');
    const blob = await buildPeriodReport({
      period,
      work,
      honors,
      summary: summarise([...work, ...honors], defaultCategories(), { today: TODAY }),
      appTitle: '政务工作记录台',
      categories: defaultCategories(),
      today: TODAY,
      generatedAt: '2026-09-20T00:00:00.000Z',
      includeHonors: true,
      includeSummary: true,
      context: records,
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const text = xml.replace(/<[^>]+>/g, '');
    expect(text).toContain('汇总各单位意见');
    expect(text).toContain('（3级子任务 · 上级：筹备示范会议 / 起草材料）');
    expect(text).toContain('（2级子任务 · 上级：另一个一级任务）');
    // A top-level task gets no second line.
    expect(text).not.toContain('1级任务');
  });
});
