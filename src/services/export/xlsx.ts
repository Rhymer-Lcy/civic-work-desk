import { formatDateValue, isIsoDate, toLocalDate } from '@/domain/dates';
import type { DateValue } from '@/domain/dates';
import { evaluateDeadline, describeVerdict, DEADLINE_SOURCE_LABELS_ZH } from '@/domain/deadlines';
import { STATUS_LABELS_ZH } from '@/domain/status';
import { isWorkRecord } from '@/domain/types';
import type {
  AnyRecord,
  BusinessCategory,
  HonorRecord,
  WorkGroup,
  WorkRecord,
} from '@/domain/types';
import { XLSX_MIME } from '../download';

/**
 * Genuine `.xlsx` export.
 *
 * The legacy `exportExcel()` hand-wrote **SpreadsheetML 2003** XML, prefixed a UTF-8 BOM to a
 * document that already declared `encoding="UTF-8"`, served it as `application/vnd.ms-excel`, and
 * named it `.xls`. Modern Excel opens that only after a security warning, and every cell was
 * emitted as `ss:Type="String"` — so dates were text and could not be sorted or filtered.
 *
 * This writes a real OOXML workbook via ExcelJS: typed date cells, column widths, wrapped text,
 * frozen header rows and an autofilter. ExcelJS is imported dynamically so it stays out of the
 * initial bundle (see vite.config.ts `manualChunks`).
 */

export interface XlsxExportInput {
  readonly records: readonly AnyRecord[];
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly today: string;
  readonly generatedAt: string;
}

interface ColumnSpec {
  readonly header: string;
  readonly width: number;
  readonly wrap?: boolean;
}

const WORK_COLUMNS: readonly ColumnSpec[] = [
  { header: '日期', width: 12 },
  { header: '事项', width: 52, wrap: true },
  { header: '业务分类', width: 16 },
  { header: '归属分组', width: 12 },
  { header: '状态', width: 10 },
  { header: '原始状态文字', width: 14 },
  { header: '长期推进', width: 10 },
  { header: '完成要求', width: 24, wrap: true },
  { header: '要求上报时限', width: 14 },
  { header: '完成时限', width: 14 },
  { header: '时限判定', width: 18 },
  { header: '完成时间', width: 14 },
  { header: '对接单位', width: 20 },
  { header: '对接人', width: 12 },
  { header: '联系方式', width: 18 },
  { header: '备注', width: 40, wrap: true },
];

const HONOR_COLUMNS: readonly ColumnSpec[] = [
  { header: '授予时间', width: 12 },
  { header: '荣誉名称', width: 46, wrap: true },
  { header: '荣誉类型', width: 20 },
  { header: '级别', width: 10 },
  { header: '授予单位', width: 28 },
  { header: '文号/编号', width: 22 },
  { header: '本人角色', width: 12 },
  { header: '关联工作事项', width: 34, wrap: true },
  { header: '佐证材料存放', width: 28, wrap: true },
  { header: '备注', width: 34, wrap: true },
];

/**
 * A cell value for a `DateValue`.
 *
 * A structured single date becomes a real date cell; anything else becomes its preserved text.
 * That is the whole point of the date model surviving into the export: a reader can sort the
 * date column, and a free-text deadline is still legible rather than blank or `1970-01-01`.
 */
function dateCell(value: DateValue): Date | string {
  if (value.kind === 'plain' && isIsoDate(value.date)) return toLocalDate(value.date);
  return formatDateValue(value, '');
}

function nameOf(id: string | null, list: readonly { id: string; name: string }[]): string {
  if (id === null) return '';
  return list.find((item) => item.id === id)?.name ?? '（已删除）';
}

function workRow(record: WorkRecord, input: XlsxExportInput): (Date | string | number)[] {
  const verdict = evaluateDeadline(record, input.today);
  const verdictText =
    verdict.source === null
      ? describeVerdict(verdict)
      : `${DEADLINE_SOURCE_LABELS_ZH[verdict.source]}·${describeVerdict(verdict)}`;
  return [
    dateCell(record.occurredOn),
    record.title,
    nameOf(record.categoryId, input.categories),
    nameOf(record.groupId, input.groups),
    STATUS_LABELS_ZH[record.status],
    record.statusLabel,
    record.longTerm ? '是' : '',
    record.requirement,
    dateCell(record.reportDeadline),
    dateCell(record.completionDeadline),
    verdictText,
    dateCell(record.completedOn),
    record.counterpartUnit,
    record.counterpartContact,
    record.counterpartPhone,
    record.remark,
  ];
}

function honorRow(record: HonorRecord, titleById: ReadonlyMap<string, string>): (Date | string)[] {
  return [
    dateCell(record.awardedOn),
    record.title,
    record.honorType,
    record.level,
    record.issuingOrg,
    record.documentNo,
    record.personalRole,
    record.relatedWorkId ? (titleById.get(record.relatedWorkId) ?? '（已删除）') : '',
    record.evidenceLocation,
    record.remark,
  ];
}

/** Build the workbook. Returns a blob with the correct OOXML media type. */
export async function buildWorkbook(input: XlsxExportInput): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CivicWorkDesk';
  workbook.created = new Date(input.generatedAt);
  // No `lastPrinted`, no company, no manager: metadata is kept minimal on purpose.

  const live = input.records.filter((record) => record.deletedAt === null);
  const work = live.filter(isWorkRecord);
  const honors = live.filter((record): record is HonorRecord => record.kind === 'honor');
  const titleById = new Map(live.map((record) => [record.id, record.title]));

  addSheet(
    workbook,
    '日常工作',
    WORK_COLUMNS,
    work.map((r) => workRow(r, input)),
  );
  addSheet(
    workbook,
    '荣誉表彰',
    HONOR_COLUMNS,
    honors.map((r) => honorRow(r, titleById)),
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

interface WorksheetLike {
  columns: { header: string; width: number; key: string }[];
  getRow(index: number): {
    font: { bold: boolean; color: { argb: string } };
    fill: { type: 'pattern'; pattern: 'solid'; fgColor: { argb: string } };
    alignment: { vertical: 'middle'; horizontal: 'center'; wrapText: boolean };
    height: number;
    commit?: () => void;
  };
  addRow(values: unknown[]): {
    getCell(index: number): { alignment: { wrapText: boolean; vertical: 'top' } };
  };
  views: { state: 'frozen'; ySplit: number }[];
  autoFilter: { from: { row: number; column: number }; to: { row: number; column: number } };
}

function addSheet(
  workbook: { addWorksheet(name: string): unknown },
  name: string,
  columns: readonly ColumnSpec[],
  rows: readonly unknown[][],
): void {
  const sheet = workbook.addWorksheet(name) as WorksheetLike;
  sheet.columns = columns.map((column, index) => ({
    header: column.header,
    width: column.width,
    key: `c${index}`,
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8C1D1D' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 26;

  for (const values of rows) {
    const row = sheet.addRow(values);
    columns.forEach((column, index) => {
      if (column.wrap === true) {
        row.getCell(index + 1).alignment = { wrapText: true, vertical: 'top' };
      }
    });
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };
}

export function ledgerFilename(stamp: string): string {
  return `civic-work-desk-ledger-${stamp}.xlsx`;
}
