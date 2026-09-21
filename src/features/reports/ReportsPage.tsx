import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FileText, Printer } from 'lucide-react';
import { useData } from '@/app/store/data-store';
import { formatDateValue } from '@/domain/dates';
import {
  formatCompletionRate,
  periodFromSelection,
  periodLastDay,
  recordsInPeriod,
  statusBreakdownLines,
  summarise,
  undatedInScope,
} from '@/domain/reports';
import type { PeriodType } from '@/domain/reports';
import { STATUS_LABELS_ZH } from '@/domain/status';
import { isWorkRecord, primaryDate } from '@/domain/types';
import type { HonorRecord, WorkRecord } from '@/domain/types';
import { downloadBlob } from '@/services/download';
import { filenameStamp } from '@/utils/clock';
import { Button, Card, EmptyState, Field, Panel, fieldControlClass } from '@/components/common';
import { useToast } from '@/components/common';
import { PageHeader } from '@/components/layout/AppShell';
import styles from './ReportsPage.module.css';

/**
 * Period reports.
 *
 * The preview and the DOCX are generated from the same `PeriodContent`, so what is shown is what
 * is exported. In the legacy prototype `previewPeriodReport()` and `exportPeriodReport()` each
 * rebuilt the list and read *different* non-existent fields (`w.require`/`w.peer` in one,
 * `w.require`/`w.peer`/`w.note` in the other), so preview and document disagreed and both were
 * missing columns.
 */

export function ReportsPage(): ReactNode {
  const data = useData();
  const toast = useToast();
  const [type, setType] = useState<PeriodType>('month');
  const [monthValue, setMonthValue] = useState(() => data.today.slice(0, 7));
  const [yearValue, setYearValue] = useState(() => data.today.slice(0, 4));
  const [includeHonors, setIncludeHonors] = useState(true);
  const [includeSummary, setIncludeSummary] = useState(true);
  const [exporting, setExporting] = useState(false);

  const period = useMemo(
    () => periodFromSelection(type, monthValue, yearValue),
    [type, monthValue, yearValue],
  );

  const content = useMemo(() => {
    if (!period) return null;
    const live = data.records.filter((record) => record.deletedAt === null);
    const inPeriod = recordsInPeriod(live, period);
    const undated = undatedInScope(live);
    const work = inPeriod.filter(isWorkRecord).sort((a, b) => compareByDate(a, b));
    const honors = inPeriod
      .filter((record): record is HonorRecord => record.kind === 'honor')
      .sort((a, b) => compareByDate(a, b));
    const scoped = includeHonors ? inPeriod : inPeriod.filter(isWorkRecord);
    return {
      period,
      work,
      honors: includeHonors ? honors : [],
      summary: summarise(scoped, data.categories, {
        today: data.today,
        undatedExcluded: undated.length,
      }),
      undated,
    };
  }, [period, data.records, data.categories, data.today, includeHonors]);

  const exportDocx = async (): Promise<void> => {
    if (!content) return;
    setExporting(true);
    try {
      const { buildPeriodReport, reportFilename } = await import('@/services/export/docx');
      const blob = await buildPeriodReport({
        ...content,
        appTitle: data.settings.appTitle,
        categories: data.categories,
        today: data.today,
        generatedAt: new Date().toISOString(),
        includeHonors,
        includeSummary,
      });
      const result = downloadBlob(blob, reportFilename(content.period.label, filenameStamp()));
      toast.show(
        `已生成 ${result.filename}（${Math.round(result.byteLength / 1024)} KB）。`,
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
      <PageHeader title="报告" description="按月 / 季 / 年整理记录，预览后导出 Word 文档或打印。" />

      <Card title="报告范围" headingLevel={2}>
        <div className={styles.controls}>
          <Field label="报告类型">
            {({ id }) => (
              <select
                id={id}
                className={fieldControlClass}
                value={type}
                onChange={(event) => {
                  setType(event.target.value as PeriodType);
                }}
              >
                <option value="month">月度报告</option>
                <option value="quarter">季度报告</option>
                <option value="year">年度报告</option>
              </select>
            )}
          </Field>

          {type === 'year' ? (
            <Field label="年份">
              {({ id }) => (
                <input
                  id={id}
                  className={fieldControlClass}
                  type="number"
                  min={1900}
                  max={2999}
                  step={1}
                  value={yearValue}
                  onChange={(event) => {
                    setYearValue(event.target.value);
                  }}
                />
              )}
            </Field>
          ) : (
            <Field label={type === 'month' ? '月份' : '季度所在月份'}>
              {({ id }) => (
                <input
                  id={id}
                  className={fieldControlClass}
                  type="month"
                  value={monthValue}
                  onChange={(event) => {
                    setMonthValue(event.target.value);
                  }}
                />
              )}
            </Field>
          )}

          <div className={styles.toggles}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={includeHonors}
                onChange={(event) => {
                  setIncludeHonors(event.target.checked);
                }}
              />
              包含荣誉记录
            </label>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={includeSummary}
                onChange={(event) => {
                  setIncludeSummary(event.target.checked);
                }}
              />
              包含统计摘要
            </label>
          </div>
        </div>

        {period ? (
          <p className={styles.range}>
            报告期：<strong>{period.label}</strong>（{period.start} 至 {periodLastDay(period)}）
          </p>
        ) : (
          <Panel tone="warning">请选择有效的月份或年份。</Panel>
        )}

        <div className={styles.actions}>
          <Button
            variant="secondary"
            icon={<Printer size={16} />}
            disabled={!content || content.summary.total === 0}
            onClick={() => {
              window.print();
            }}
          >
            打印预览
          </Button>
          <Button
            variant="primary"
            icon={<FileText size={16} />}
            busy={exporting}
            disabled={!content || content.summary.total === 0}
            onClick={() => void exportDocx()}
          >
            导出 Word 文档（.docx）
          </Button>
        </div>
      </Card>

      {content === null ? null : content.summary.total === 0 ? (
        <EmptyState
          title={`${content.period.label} 没有记录`}
          description={
            content.undated.length > 0
              ? `另有 ${content.undated.length} 条记录的日期为文字描述，无法归入任何报告期。`
              : undefined
          }
        />
      ) : (
        <div className="print-area">
          {includeSummary ? (
            <Card title={`${content.period.label} 统计摘要`} headingLevel={2}>
              <div className={styles.summaryGrid}>
                <SummaryItem label="记录总数" value={content.summary.total} />
                <SummaryItem label="工作记录" value={content.summary.workTotal} />
                <SummaryItem label="荣誉记录" value={content.summary.honorTotal} />
                <SummaryItem
                  label="完成率"
                  value={formatCompletionRate(content.summary.completionRate)}
                  detail="分母已扣除已取消项"
                />
                <SummaryItem label="已逾期" value={content.summary.overdue} />
                <SummaryItem
                  label="历史遗留"
                  value={content.summary.staleBacklog}
                  detail="逾期 30 天以上"
                />
              </div>

              <table className={styles.breakdown}>
                <caption className={styles.caption}>状态分布</caption>
                <tbody>
                  {statusBreakdownLines(content.summary).map((line) => (
                    <tr key={line.label}>
                      <th scope="row">{line.label}</th>
                      <td>{line.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {content.summary.byCategory.length > 0 ? (
                <table className={styles.breakdown}>
                  <caption className={styles.caption}>业务分类分布</caption>
                  <tbody>
                    {content.summary.byCategory.map((row) => (
                      <tr key={row.categoryId ?? 'none'}>
                        <th scope="row">{row.name}</th>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              {content.undated.length > 0 ? (
                <Panel tone="warning">
                  另有 {content.undated.length} 条记录的日期为文字描述（如「1月」「待定」），
                  无法归入任何报告期，未计入以上统计。可在「工作」或「台账」中搜索并补齐日期。
                </Panel>
              ) : null}
            </Card>
          ) : null}

          <Card title="工作记录" headingLevel={2}>
            {content.work.length === 0 ? (
              <p className={styles.note}>本报告期内没有工作记录。</p>
            ) : (
              <ol className={styles.recordList}>
                {content.work.map((record) => (
                  <li key={record.id} className={styles.recordItem}>
                    <p className={styles.recordTitle}>{record.title}</p>
                    <p className={styles.recordMeta}>
                      {[
                        formatDateValue(record.occurredOn, ''),
                        STATUS_LABELS_ZH[record.status],
                        record.requirement,
                        record.counterpartUnit,
                      ]
                        .filter((part) => part.trim() !== '')
                        .join('　·　')}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {includeHonors ? (
            <Card title="荣誉表彰" headingLevel={2}>
              {content.honors.length === 0 ? (
                <p className={styles.note}>本报告期内没有荣誉记录。</p>
              ) : (
                <ol className={styles.recordList}>
                  {content.honors.map((record) => (
                    <li key={record.id} className={styles.recordItem}>
                      <p className={styles.recordTitle}>{record.title}</p>
                      <p className={styles.recordMeta}>
                        {[
                          formatDateValue(record.awardedOn, ''),
                          record.level,
                          record.honorType,
                          record.issuingOrg,
                        ]
                          .filter((part) => part.trim() !== '')
                          .join('　·　')}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}

function compareByDate(a: WorkRecord | HonorRecord, b: WorkRecord | HonorRecord): number {
  const da = formatDateValue(primaryDate(a), '');
  const db = formatDateValue(primaryDate(b), '');
  return da.localeCompare(db);
}

function SummaryItem({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly detail?: string;
}): ReactNode {
  return (
    <div className={styles.summaryItem}>
      <span className={styles.summaryValue}>{value}</span>
      <span className={styles.summaryLabel}>{label}</span>
      {detail ? <span className={styles.summaryDetail}>{detail}</span> : null}
    </div>
  );
}
