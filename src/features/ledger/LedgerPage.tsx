import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FileSpreadsheet, Printer } from 'lucide-react';
import { useData } from '@/app/store/data-store';
import { formatDateValue } from '@/domain/dates';
import { describeVerdictWithSource, evaluateDeadline } from '@/domain/deadlines';
import { WORK_LEVEL_LABELS_ZH } from '@/domain/hierarchy';
import { describePath, hierarchyContext, indexRecords } from '@/domain/hierarchy-summary';
import type { WorkIndex } from '@/domain/hierarchy-summary';
import { EMPTY_QUERY, countUndated, distinctUnits, distinctYears, runQuery } from '@/domain/query';
import type { RecordQuery } from '@/domain/query';
import { STATUS_LABELS_ZH } from '@/domain/status';
import { isWorkRecord, primaryDate } from '@/domain/types';
import type { AnyRecord } from '@/domain/types';
import { downloadBlob } from '@/services/download';
import { filenameStamp } from '@/utils/clock';
import { Button, EmptyState, HonorBadge, StatusBadge, UrgencyBadge } from '@/components/common';
import { useToast } from '@/components/common';
import { PageHeader } from '@/components/layout/AppShell';
import { useMediaQuery, usePrinting } from '@/app/use-media-query';
import { LEDGER_TABLE_QUERY } from '@/styles/breakpoints';
import { FilterBar } from '../work/FilterBar';
import styles from './LedgerPage.module.css';

/**
 * Ledger: a dense table for desktop, a card list for narrow screens.
 *
 * The legacy ledger responded to width by making every `<td>` a block and injecting the column
 * name through `td::before { content: attr(data-label) }`. That works visually but leaves the
 * table semantics in place while removing the visual table, so a screen reader still announced
 * "row 12, column 4" over what was rendered as a paragraph. Here the two presentations are
 * genuinely different markup.
 *
 * Only one of them is rendered. Until Phase 5 both were, for every row, and CSS hid one: at 5,000
 * records that doubled the DOM the page built, and switching to 台账 was measurably slower for it
 * (docs/phase-5-evidence.md §3). The choice is `LEDGER_TABLE_QUERY`, read synchronously on the first
 * render, and printing always takes the table, whatever the window width.
 */

export function LedgerPage(): ReactNode {
  const data = useData();
  const toast = useToast();
  const [query, setQuery] = useState<RecordQuery>({ ...EMPTY_QUERY, sort: 'date-desc' });
  const [exporting, setExporting] = useState(false);

  const results = useMemo(
    () => runQuery(data.records, query, { today: data.today }),
    [data.records, data.today, query],
  );
  // Parents are resolved against every record, not the filtered rows (Phase 5).
  const index = useMemo(() => indexRecords(data.records), [data.records]);
  const units = useMemo(() => distinctUnits(data.records), [data.records]);
  const years = useMemo(() => distinctYears(data.records), [data.records]);
  const wide = useMediaQuery(LEDGER_TABLE_QUERY, true);
  const printing = usePrinting();
  const presentation: LedgerPresentation = wide || printing ? 'table' : 'cards';

  const exportXlsx = async (): Promise<void> => {
    setExporting(true);
    try {
      const { buildWorkbook, ledgerFilename } = await import('@/services/export/xlsx');
      const blob = await buildWorkbook({
        records: results,
        context: data.records,
        categories: data.categories,
        groups: data.groups,
        today: data.today,
        generatedAt: new Date().toISOString(),
      });
      const result = downloadBlob(blob, ledgerFilename(filenameStamp()));
      toast.show(
        `已生成 ${result.filename}（${results.length} 条，${Math.round(result.byteLength / 1024)} KB）。`,
        'success',
      );
    } catch (cause) {
      toast.show(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="台账"
        description="全部记录的表格视图，按当前筛选条件导出或打印。"
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Printer size={16} />}
              onClick={() => {
                window.print();
              }}
            >
              打印
            </Button>
            <Button
              variant="primary"
              icon={<FileSpreadsheet size={16} />}
              busy={exporting}
              onClick={() => void exportXlsx()}
            >
              导出 XLSX
            </Button>
          </>
        }
      />

      <FilterBar
        query={query}
        onChange={setQuery}
        categories={data.categories}
        groups={data.groups}
        units={units}
        years={years}
        resultCount={results.length}
        undatedCount={countUndated(data.records)}
      />

      {results.length === 0 ? (
        <EmptyState title="没有符合条件的记录" description="调整筛选条件后再试。" />
      ) : (
        <div className="print-area">
          <p className="print-only">
            {data.settings.appTitle} · 工作台账 · 共 {results.length} 条 · 导出日期 {data.today}
          </p>

          {presentation === 'table' ? (
            <LedgerTable
              results={results}
              index={index}
              today={data.today}
              categories={data.categories}
            />
          ) : (
            <ul className={styles.cards} data-ledger-presentation="cards">
              {results.map((record) => (
                <LedgerCard
                  key={record.id}
                  record={record}
                  hierarchy={ledgerHierarchy(index, record)}
                  today={data.today}
                  categoryName={categoryNameOf(record, data.categories)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

type LedgerPresentation = 'table' | 'cards';

function LedgerTable({
  results,
  index,
  today,
  categories,
}: {
  readonly results: readonly AnyRecord[];
  readonly index: WorkIndex;
  readonly today: string;
  readonly categories: readonly { readonly id: string; readonly name: string }[];
}): ReactNode {
  return (
    <div className={styles.tableWrap} data-ledger-presentation="table">
      <table className={styles.table}>
        <caption className="visually-hidden">工作与荣誉台账，共 {results.length} 条记录</caption>
        {/*
         * Declared widths, in percentages so the table still fills a 1920 viewport and a
         * 1280 one. The title and the remark get the room; 类别 and the two deadline columns
         * get exactly what their content needs and no more.
         */}
        <colgroup>
          <col className={styles.colDate} />
          <col className={styles.colKind} />
          <col className={styles.colLevel} />
          <col className={styles.colTitle} />
          <col className={styles.colCategory} />
          <col className={styles.colStatus} />
          <col className={styles.colDeadline} />
          <col className={styles.colDeadline} />
          <col className={styles.colVerdict} />
          <col className={styles.colCounterpart} />
          <col className={styles.colRemark} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">日期</th>
            <th scope="col">类别</th>
            <th scope="col">层级</th>
            <th scope="col">事项 / 荣誉名称</th>
            <th scope="col">业务分类</th>
            <th scope="col">状态</th>
            <th scope="col">上报时限</th>
            <th scope="col">完成时限</th>
            <th scope="col">时限判定</th>
            <th scope="col">对接单位 / 人</th>
            <th scope="col">备注</th>
          </tr>
        </thead>
        <tbody>
          {results.map((record) => (
            <LedgerRow
              key={record.id}
              record={record}
              hierarchy={ledgerHierarchy(index, record)}
              today={today}
              categoryName={categoryNameOf(record, categories)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function categoryNameOf(
  record: AnyRecord,
  categories: readonly { readonly id: string; readonly name: string }[],
): string {
  if (!isWorkRecord(record) || record.categoryId === null) return '';
  return categories.find((c) => c.id === record.categoryId)?.name ?? '（已删除）';
}

/** A record's level and parent path for the ledger. An honour has neither. */
interface LedgerHierarchy {
  readonly level: string;
  readonly path: string;
}

function ledgerHierarchy(index: WorkIndex, record: AnyRecord): LedgerHierarchy {
  if (!isWorkRecord(record)) return { level: '—', path: '' };
  const { level, ancestors } = hierarchyContext(index, record.id);
  return {
    level: level === null ? '层级异常' : WORK_LEVEL_LABELS_ZH[level],
    path: describePath(ancestors),
  };
}

function LedgerRow({
  record,
  hierarchy,
  today,
  categoryName,
}: {
  readonly record: AnyRecord;
  readonly hierarchy: LedgerHierarchy;
  readonly today: string;
  readonly categoryName: string;
}): ReactNode {
  const cells = ledgerCells(record, today, categoryName);
  return (
    <tr>
      <td className={styles.cellDate}>{cells.date}</td>
      <td className={styles.cellKind}>{cells.kind}</td>
      <td className={styles.cellLevel}>{hierarchy.level}</td>
      <td className={styles.cellTitle}>
        {record.title}
        {hierarchy.path !== '' ? (
          <span className={styles.titlePath}>上级：{hierarchy.path}</span>
        ) : null}
      </td>
      <td>{cells.category}</td>
      <td className={styles.cellStatus}>{cells.status}</td>
      <td className={styles.cellDate}>{cells.reportDeadline}</td>
      <td className={styles.cellDate}>{cells.completionDeadline}</td>
      <td>{cells.verdict}</td>
      <td>{cells.counterpart}</td>
      <td className={styles.remark}>{cells.remark}</td>
    </tr>
  );
}

interface LedgerCells {
  readonly date: string;
  readonly kind: string;
  readonly category: string;
  readonly status: string;
  readonly reportDeadline: string;
  readonly completionDeadline: string;
  readonly verdict: string;
  readonly counterpart: string;
  readonly remark: string;
}

/**
 * Flatten a record into the ledger's per-record columns. The 层级 column and the parent path under
 * the title come from `ledgerHierarchy`, which needs the whole archive rather than one record.
 *
 * Separated from the row component so the branching over work/honour happens once, in plain
 * TypeScript, rather than being repeated inline in ten JSX expressions.
 */
function ledgerCells(record: AnyRecord, today: string, categoryName: string): LedgerCells {
  const dash = '—';
  const date = formatDateValue(primaryDate(record));
  const remark = record.remark || dash;

  if (isWorkRecord(record)) {
    const verdict = evaluateDeadline(record, today);
    const counterpart = [record.counterpartUnit, record.counterpartContact]
      .filter((part) => part !== '')
      .join(' / ');
    return {
      date,
      kind: '工作',
      category: categoryName || '未分类',
      status: STATUS_LABELS_ZH[record.status] + (record.longTerm ? '（长期）' : ''),
      reportDeadline: formatDateValue(record.reportDeadline),
      completionDeadline: formatDateValue(record.completionDeadline),
      verdict: describeVerdictWithSource(verdict),
      counterpart: counterpart || dash,
      remark,
    };
  }

  return {
    date,
    kind: '荣誉',
    category: dash,
    status: record.level || '荣誉',
    reportDeadline: dash,
    completionDeadline: dash,
    verdict: dash,
    counterpart: record.issuingOrg || dash,
    remark,
  };
}

function LedgerCard({
  record,
  hierarchy,
  today,
  categoryName,
}: {
  readonly record: AnyRecord;
  readonly hierarchy: LedgerHierarchy;
  readonly today: string;
  readonly categoryName: string;
}): ReactNode {
  const work = isWorkRecord(record) ? record : null;
  const honor = record.kind === 'honor' ? record : null;
  const verdict = work ? evaluateDeadline(work, today) : null;
  return (
    <li className={styles.card}>
      <p className={styles.cardTitle}>{record.title}</p>
      <div className={styles.cardBadges}>
        {work ? <StatusBadge status={work.status} /> : <HonorBadge level={honor?.level ?? ''} />}
        {verdict ? (
          <UrgencyBadge level={verdict.level} text={describeVerdictWithSource(verdict)} />
        ) : null}
      </div>
      <dl className={styles.cardFields}>
        <CardField label="日期" value={formatDateValue(primaryDate(record))} />
        {work ? <CardField label="任务层级" value={hierarchy.level} /> : null}
        <CardField label="上级任务" value={hierarchy.path} />
        <CardField label="业务分类" value={categoryName} />
        <CardField
          label={work ? '对接单位 / 人' : '授予单位'}
          value={
            work
              ? [work.counterpartUnit, work.counterpartContact].filter((p) => p !== '').join(' / ')
              : (honor?.issuingOrg ?? '')
          }
        />
        {work ? (
          <CardField label="上报时限" value={formatDateValue(work.reportDeadline, '')} />
        ) : null}
        {work ? (
          <CardField label="完成时限" value={formatDateValue(work.completionDeadline, '')} />
        ) : null}
        {honor ? <CardField label="文号 / 编号" value={honor.documentNo} /> : null}
        <CardField label="备注" value={record.remark} />
      </dl>
    </li>
  );
}

function CardField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  if (value.trim() === '' || value === '—') return null;
  return (
    <div className={styles.cardField}>
      <dt className={styles.cardLabel}>{label}</dt>
      <dd className={styles.cardValue}>{value}</dd>
    </div>
  );
}
