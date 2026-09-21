import type { Paragraph as ParagraphNode, Table as TableNode } from 'docx';
import { formatDateValue } from '@/domain/dates';
import { DEADLINE_SOURCE_LABELS_ZH, describeVerdict, evaluateDeadline } from '@/domain/deadlines';
import { formatCompletionRate, statusBreakdownLines } from '@/domain/reports';
import type { PeriodContent } from '@/domain/reports';
import { STATUS_LABELS_ZH } from '@/domain/status';
import type { BusinessCategory, HonorRecord, WorkRecord } from '@/domain/types';
import { formatInstant } from '@/utils/clock';
import { DOCX_MIME } from '../download';

/**
 * Genuine `.docx` period report.
 *
 * The legacy `exportPeriodReport()` emitted an HTML string with an `application/msword` media type
 * and a `.doc` extension. Worse, the markup was malformed: it opened with `<thead>` and no
 * `<table>`, so the `table { border-collapse … }` rules it defined could never apply and the
 * closing `</table>` was a stray tag. It also read `w.require`, `w.peer`, `w.name` and `w.status`
 * — none of which are fields — so the "完成要求" column was empty on every row and the contact
 * person never appeared.
 *
 * This produces a real OOXML document through the `docx` library from the canonical domain types.
 * The library's *values* are loaded with a dynamic `import()` so it lands in its own async chunk;
 * its *types* are imported with `import type`, which `verbatimModuleSyntax` erases entirely, so
 * the bundle is unaffected while the code stays fully typed.
 */

export interface DocxReportInput extends PeriodContent {
  readonly appTitle: string;
  readonly categories: readonly BusinessCategory[];
  readonly today: string;
  readonly generatedAt: string;
  readonly includeHonors: boolean;
  readonly includeSummary: boolean;
}

const FONT = 'SimSun';
const HEADER_FILL = 'F3EFEA';
const BODY_SIZE = 21;
const TABLE_SIZE = 18;

export async function buildPeriodReport(input: DocxReportInput): Promise<Blob> {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import('docx');

  const text = (value: string, bold = false, size = BODY_SIZE): InstanceType<typeof TextRun> =>
    new TextRun({ text: value, bold, font: FONT, size });

  const para = (value: string, bold = false): ParagraphNode =>
    new Paragraph({ spacing: { after: 120 }, children: [text(value, bold)] });

  const centred = (value: string, bold: boolean, size: number): ParagraphNode =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [text(value, bold, size)],
    });

  const heading = (value: string): ParagraphNode =>
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240, after: 120 },
      children: [text(value, true, 26)],
    });

  // `shading` is only supplied for header cells. Passing `shading: undefined` explicitly would be
  // rejected under exactOptionalPropertyTypes, so the key is omitted rather than set to undefined.
  const cell = (value: string, bold = false, shaded = false): InstanceType<typeof TableCell> => {
    const paragraph = new Paragraph({
      spacing: { after: 0 },
      children: [text(value, bold, TABLE_SIZE)],
    });
    const margins = { top: 60, bottom: 60, left: 80, right: 80 };
    return shaded
      ? new TableCell({ shading: { fill: HEADER_FILL }, margins, children: [paragraph] })
      : new TableCell({ margins, children: [paragraph] });
  };

  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' } as const;
  const innerBorder = { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' } as const;

  const table = (headers: readonly string[], rows: readonly (readonly string[])[]): TableNode =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: border,
        bottom: border,
        left: border,
        right: border,
        insideHorizontal: innerBorder,
        insideVertical: innerBorder,
      },
      rows: [
        new TableRow({
          tableHeader: true,
          children: headers.map((header) => cell(header, true, true)),
        }),
        ...rows.map((row) => new TableRow({ children: row.map((value) => cell(value)) })),
      ],
    });

  const categoryName = (id: string | null): string =>
    id === null ? '未分类' : (input.categories.find((c) => c.id === id)?.name ?? '（已删除）');

  const children: (ParagraphNode | TableNode)[] = [
    centred(`${input.period.label} 工作台账`, true, 36),
    centred(input.appTitle, false, 20),
    para(
      `报告期：${input.period.label}　|　报告类型：${periodTypeLabel(input.period.type)}` +
        `　|　生成时间：${formatInstant(input.generatedAt)}`,
    ),
  ];

  let sectionNumber = 0;
  const nextSection = (title: string): string => {
    sectionNumber += 1;
    return `${['一', '二', '三', '四'][sectionNumber - 1] ?? String(sectionNumber)}、${title}`;
  };

  if (input.includeSummary) {
    const s = input.summary;
    children.push(
      heading(nextSection('统计摘要')),
      para(`记录总数 ${s.total} 条（工作 ${s.workTotal} 条，荣誉 ${s.honorTotal} 条）。`),
      para(
        statusBreakdownLines(s)
          .map((line) => `${line.label} ${line.count}`)
          .join('　'),
      ),
      para(
        `完成率 ${formatCompletionRate(s.completionRate)}` +
          `（分母为工作记录扣除已取消项；已取消 ${s.byStatus.cancelled} 条不计入）。`,
      ),
      para(
        `逾期 ${s.overdue} 条；逾期超 30 天的历史遗留另计 ${s.staleBacklog} 条；` +
          `长期推进 ${s.longTerm} 条。`,
      ),
    );
    if (s.undatedExcluded > 0) {
      children.push(
        para(
          `另有 ${s.undatedExcluded} 条记录的日期为文字描述（如「1月」「待定」），` +
            `无法归入任何报告期，未计入上述统计。`,
          true,
        ),
      );
    }
    if (s.byCategory.length > 0) {
      children.push(
        para('业务分类分布：'),
        table(
          ['业务分类', '数量'],
          s.byCategory.map((row) => [row.name, String(row.count)]),
        ),
      );
    }
  }

  children.push(heading(nextSection('工作记录')));
  if (input.work.length === 0) {
    children.push(para('本报告期内没有工作记录。'));
  } else {
    children.push(
      table(
        [
          '序',
          '日期',
          '事项',
          '业务分类',
          '完成要求',
          '上报时限',
          '完成时限',
          '状态',
          '时限判定',
          '对接单位/人',
          '备注',
        ],
        input.work.map((record, index) => workRow(record, index, input.today, categoryName)),
      ),
    );
  }

  if (input.includeHonors) {
    children.push(heading(nextSection('荣誉表彰')));
    if (input.honors.length === 0) {
      children.push(para('本报告期内没有荣誉记录。'));
    } else {
      children.push(
        table(
          [
            '序',
            '授予时间',
            '荣誉名称',
            '类型',
            '级别',
            '授予单位',
            '文号/编号',
            '本人角色',
            '佐证材料存放',
          ],
          input.honors.map((record, index) => honorRow(record, index)),
        ),
      );
    }
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 360 },
      children: [
        text(`由「${input.appTitle}」于 ${formatInstant(input.generatedAt)} 生成`, false, 16),
      ],
    }),
  );

  const document = new Document({
    creator: 'CivicWorkDesk',
    title: `${input.period.label} 工作台账`,
    description: '本地生成的工作台账报告',
    styles: { default: { document: { run: { font: FONT, size: BODY_SIZE } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(document);
  return new Blob([blob], { type: DOCX_MIME });
}

function workRow(
  record: WorkRecord,
  index: number,
  today: string,
  categoryName: (id: string | null) => string,
): string[] {
  const verdict = evaluateDeadline(record, today);
  const verdictText =
    verdict.source === null
      ? describeVerdict(verdict)
      : `${DEADLINE_SOURCE_LABELS_ZH[verdict.source]}·${describeVerdict(verdict)}`;
  const counterpart = [record.counterpartUnit, record.counterpartContact]
    .filter((part) => part.trim() !== '')
    .join(' / ');
  return [
    String(index + 1),
    formatDateValue(record.occurredOn, '—'),
    record.title,
    categoryName(record.categoryId),
    record.requirement || '—',
    formatDateValue(record.reportDeadline, '—'),
    formatDateValue(record.completionDeadline, '—'),
    STATUS_LABELS_ZH[record.status] + (record.longTerm ? '（长期）' : ''),
    verdictText,
    counterpart || '—',
    record.remark || '—',
  ];
}

function honorRow(record: HonorRecord, index: number): string[] {
  return [
    String(index + 1),
    formatDateValue(record.awardedOn, '—'),
    record.title,
    record.honorType || '—',
    record.level || '—',
    record.issuingOrg || '—',
    record.documentNo || '—',
    record.personalRole || '—',
    record.evidenceLocation || '—',
  ];
}

function periodTypeLabel(type: PeriodContent['period']['type']): string {
  return type === 'month' ? '月度报告' : type === 'quarter' ? '季度报告' : '年度报告';
}

export function reportFilename(periodLabel: string, stamp: string): string {
  const slug = periodLabel.replace(/[^\p{Script=Han}\w-]+/gu, '');
  return `civic-work-desk-report-${slug}-${stamp}.docx`;
}
