import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, BookOpen, Download, ListChecks } from 'lucide-react';
import { usePrimaryAction } from '@/app/primary-action-context';
import { useData } from '@/app/store/data-store';
import { invalidRowCount } from '@/db/snapshot';
import type { RouteId } from '@/app/router';
import { formatDateValue } from '@/domain/dates';
import { describeVerdictWithSource, evaluateDeadline, isStaleBacklog } from '@/domain/deadlines';
import { followUpList } from '@/domain/query';
import { summarise } from '@/domain/reports';
import { isWorkRecord } from '@/domain/types';
import type { WorkRecord } from '@/domain/types';
import { describeBackupHealth } from '@/services/backup';
import { Button, Card, Panel, UrgencyBadge } from '@/components/common';
import { PageHeader, Section, SplitLayout } from '@/components/layout/AppShell';
import { MonthCalendar } from '../calendar/MonthCalendar';
import { GroupPanel } from '../groups/GroupPanel';
import { WorkRecordDialog } from '../work/WorkRecordDialog';
import type { WorkDraft } from '../work/work-draft';
import { useRecordActions } from '../work/use-record-actions';
import styles from './DashboardPage.module.css';

/**
 * 概览 — what needs attention now.
 *
 * Phase 1 answered a different question. Six equal tiles occupied the first screen, the first of them
 * (需要跟进) was the union of the next three, two more described history rather than a decision, and
 * the list directly beneath restated the first tile's number as its own contents (audit D-1, D-2).
 * On an empty database the same six tiles rendered as six large zeroes (D-5).
 *
 * Phase 2 keeps every number that changes what somebody does today and demotes the rest:
 *
 *   1. **three attention counts** — overdue, due today, due within 7 days — as one compact band,
 *      each a filter into 工作 rather than a decoration;
 *   2. **需要跟进**, the list itself, which was and remains the best thing on this page;
 *   3. calendar and groups in the aside, for context rather than management;
 *   4. one quiet line of workload totals at the end, where 已完成 and 工作记录共 N 条 belong.
 *
 * The empty database gets a different page entirely rather than the same page full of zeroes.
 */

export function DashboardPage({
  onNavigate,
}: {
  readonly onNavigate: (route: RouteId) => void;
}): ReactNode {
  const data = useData();
  const actions = useRecordActions();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openCreate = useCallback(() => {
    setDialogOpen(true);
  }, []);
  usePrimaryAction('新增记录', openCreate);

  const live = useMemo(() => data.records.filter((r) => r.deletedAt === null), [data.records]);
  const summary = useMemo(
    () => summarise(live, data.categories, { today: data.today }),
    [live, data.categories, data.today],
  );
  const followUp = useMemo(() => followUpList(live, { today: data.today }), [live, data.today]);

  const dueToday = followUp.filter(
    (record) => evaluateDeadline(record, data.today).level === 'due-today',
  ).length;
  const dueSoon = followUp.filter(
    (record) => evaluateDeadline(record, data.today).level === 'due-soon',
  ).length;
  const activeLongTerm = live.filter(
    (record) =>
      isWorkRecord(record) &&
      record.longTerm &&
      record.status !== 'completed' &&
      record.status !== 'cancelled',
  ).length;

  const dayRecords = useMemo(() => {
    if (selectedDay === null) return [];
    return live.filter((record) => {
      const date = record.kind === 'work' ? record.occurredOn : record.awardedOn;
      if (date.kind === 'plain') return date.date === selectedDay;
      if (date.kind === 'range') return date.start <= selectedDay && date.end >= selectedDay;
      return false;
    });
  }, [live, selectedDay]);

  const backupStale = data.backupHealth.state === 'stale' || data.backupHealth.state === 'never';
  const firstRun = live.length === 0;

  return (
    <>
      <PageHeader title="概览" description={`今天是 ${data.today}。`} />

      {backupStale && !firstRun ? (
        <Panel tone="warning">
          <div className={styles.banner}>
            <AlertTriangle aria-hidden="true" size={16} />
            <p className={styles.bannerText}>
              {describeBackupHealth(data.backupHealth)}只有 JSON 备份可以完整还原本机数据。
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onNavigate('settings');
              }}
            >
              前往备份
            </Button>
          </div>
        </Panel>
      ) : null}

      {invalidRowCount(data.integrity) > 0 ? (
        <Panel tone="danger">
          <p>
            本机有 {invalidRowCount(data.integrity)}{' '}
            行数据未通过校验，已从列表中排除，内容未被修改； 在处理之前无法导出完整备份。详见「设置
            → 数据诊断」。
          </p>
        </Panel>
      ) : null}

      {firstRun ? (
        <FirstRun onCreate={openCreate} onNavigate={onNavigate} />
      ) : (
        <SplitLayout
          main={
            <>
              <div className={styles.attention}>
                <AttentionCell
                  label="已逾期"
                  value={summary.overdue}
                  tone={summary.overdue > 0 ? 'alert' : 'calm'}
                  hint={
                    summary.staleBacklog > 0
                      ? `另有 ${summary.staleBacklog} 条历史遗留`
                      : '超过时限尚未结束'
                  }
                  onActivate={() => {
                    onNavigate('work');
                  }}
                />
                <AttentionCell
                  label="今日到期"
                  value={dueToday}
                  tone={dueToday > 0 ? 'warn' : 'calm'}
                  hint="今天是最后期限"
                  onActivate={() => {
                    onNavigate('work');
                  }}
                />
                <AttentionCell
                  label="7 天内到期"
                  value={dueSoon}
                  tone="calm"
                  hint="本周需要安排"
                  onActivate={() => {
                    onNavigate('work');
                  }}
                />
              </div>

              <Section
                title="需要跟进"
                description="按紧迫度排序；逾期超过 30 天的历史遗留不在此处打扰。"
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ArrowRight size={14} />}
                    onClick={() => {
                      onNavigate('work');
                    }}
                  >
                    全部工作
                  </Button>
                }
              >
                {followUp.length === 0 ? (
                  <p className={styles.clear}>
                    近期没有逾期或临近到期的事项。共 {summary.workTotal} 条工作记录， 其中
                    {summary.byStatus['in-progress']} 条进行中。
                  </p>
                ) : (
                  <ul className={styles.followList}>
                    {followUp.slice(0, 12).map((record) => (
                      <FollowUpRow key={record.id} record={record} today={data.today} />
                    ))}
                  </ul>
                )}
                {summary.staleBacklog > 0 ? (
                  <p className={styles.note}>
                    另有 {summary.staleBacklog} 条逾期超过 30
                    天的历史遗留事项未在此列出，可在「工作」 中按「历史遗留」筛选。
                  </p>
                ) : null}
              </Section>

              {selectedDay !== null ? (
                <Section title={`${selectedDay} 的记录`} headingLevel={3}>
                  {dayRecords.length === 0 ? (
                    <p className={styles.note}>这一天没有记录。</p>
                  ) : (
                    <ul className={styles.dayList}>
                      {dayRecords.map((record) => (
                        <li key={record.id} className={styles.dayItem}>
                          <span className={styles.dayKind}>
                            {record.kind === 'work' ? '工作' : '荣誉'}
                          </span>
                          {record.title}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              ) : null}

              {/*
               * Workload, not attention. These numbers describe what has happened rather than what to
               * do, so they are one quiet line at the end instead of three tiles at the top.
               */}
              <p className={styles.workload}>
                工作记录共 {summary.workTotal} 条 · 进行中 {summary.byStatus['in-progress']} 条 ·
                长期推进（未结束）{activeLongTerm} 条 · 已完成 {summary.byStatus.completed} 条
              </p>
            </>
          }
          aside={
            <>
              <Card title="日历" headingLevel={3}>
                <MonthCalendar
                  records={live}
                  selected={selectedDay}
                  onSelect={setSelectedDay}
                  today={data.today}
                />
              </Card>
              <GroupPanel
                records={live}
                groups={data.groups}
                today={data.today}
                onOpenWork={() => {
                  onNavigate('work');
                }}
              />
            </>
          }
        />
      )}

      <WorkRecordDialog
        open={dialogOpen}
        editing={null}
        categories={data.categories}
        groups={data.groups}
        onSubmit={async (draft: WorkDraft) => {
          await actions.saveWork(draft, null);
        }}
        onClose={() => {
          setDialogOpen(false);
        }}
      />
    </>
  );
}

/**
 * One attention count.
 *
 * A button, not a tile: every one of these is a question whose answer is "show me those records", and
 * the number is the affordance. `tone` is carried by a left rule and the numeral's colour, and the
 * hint line states the meaning in words, so the distinction survives without colour.
 */
function AttentionCell({
  label,
  value,
  hint,
  tone,
  onActivate,
}: {
  readonly label: string;
  readonly value: number;
  readonly hint: string;
  readonly tone: 'alert' | 'warn' | 'calm';
  readonly onActivate: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`${styles.cell} ${styles[`cell-${tone}`]}`}
      onClick={onActivate}
      aria-label={`${label} ${String(value)} 条，在工作列表中查看`}
    >
      <span className={styles.cellValue}>{value}</span>
      <span className={styles.cellLabel}>{label}</span>
      <span className={styles.cellHint}>{hint}</span>
    </button>
  );
}

/**
 * First run.
 *
 * Six zeroes explain nothing, and a 250 px empty card is the largest object on the page precisely
 * when there is least to say (audit D-5). This states what the product is for, gives the one action
 * that matters, and names the two things a new user will need next.
 */
function FirstRun({
  onCreate,
  onNavigate,
}: {
  readonly onCreate: () => void;
  readonly onNavigate: (route: RouteId) => void;
}): ReactNode {
  return (
    <section className={styles.firstRun}>
      <h2 className={styles.firstRunTitle}>开始建立你的工作记录</h2>
      <p className={styles.firstRunLead}>
        CivicWorkDesk 用来登记日常工作事项与荣誉表彰：记录时限与进展、按分类与分组归档、
        随时导出台账与阶段报告。数据只保存在本机浏览器，不上传任何服务器。
      </p>
      <div className={styles.firstRunAction}>
        <Button variant="primary" size="lg" onClick={onCreate}>
          新增第一条记录
        </Button>
      </div>
      <ul className={styles.firstRunHints}>
        <li className={styles.firstRunHint}>
          <ListChecks aria-hidden="true" size={18} className={styles.firstRunIcon} />
          <span>
            <strong>登记事项</strong>
            <span className={styles.firstRunHintText}>
              填写事项、时限与对接单位；概览会按紧迫度提醒需要跟进的记录。
            </span>
          </span>
        </li>
        <li className={styles.firstRunHint}>
          <BookOpen aria-hidden="true" size={18} className={styles.firstRunIcon} />
          <span>
            <strong>已有旧数据</strong>
            <span className={styles.firstRunHintText}>
              在「设置 → 数据与备份」中导入旧版「工作记录台」的 JSON 文件。
            </span>
          </span>
        </li>
        <li className={styles.firstRunHint}>
          <Download aria-hidden="true" size={18} className={styles.firstRunIcon} />
          <span>
            <strong>定期备份</strong>
            <span className={styles.firstRunHintText}>
              只有 JSON 备份可以完整还原；XLSX 与 Word 是报表，不能用于还原。
            </span>
          </span>
        </li>
      </ul>
      <p className={styles.firstRunFoot}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onNavigate('settings');
          }}
        >
          打开设置
        </Button>
      </p>
    </section>
  );
}

function FollowUpRow({
  record,
  today,
}: {
  readonly record: WorkRecord;
  readonly today: string;
}): ReactNode {
  const verdict = evaluateDeadline(record, today);
  return (
    <li className={`${styles.followItem} ${isStaleBacklog(verdict) ? styles.followStale : ''}`}>
      <div className={styles.followMain}>
        <p className={styles.followTitle}>{record.title}</p>
        <p className={styles.followMeta}>
          {[record.counterpartUnit, record.requirement, formatDateValue(record.occurredOn, '')]
            .filter((part) => part.trim() !== '')
            .join('　·　')}
        </p>
      </div>
      <UrgencyBadge level={verdict.level} text={describeVerdictWithSource(verdict)} />
    </li>
  );
}
