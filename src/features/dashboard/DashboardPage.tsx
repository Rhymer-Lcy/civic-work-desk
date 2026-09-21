import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Plus } from 'lucide-react';
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
import { Button, Card, EmptyState, Metric, Panel, UrgencyBadge } from '@/components/common';
import { PageHeader, SplitLayout } from '@/components/layout/AppShell';
import { MonthCalendar } from '../calendar/MonthCalendar';
import { GroupPanel } from '../groups/GroupPanel';
import { WorkRecordDialog } from '../work/WorkRecordDialog';
import type { WorkDraft } from '../work/work-draft';
import { useRecordActions } from '../work/use-record-actions';
import styles from './DashboardPage.module.css';

/**
 * Dashboard.
 *
 * Six metrics, chosen because each one implies an action. The legacy statistics bar had seven
 * tiles including "工作记录" (the total, which never changes what anybody does that day) and
 * computed two of them — 逾期 and 今日到期 — from a different deadline reading than the tab badges
 * directly beneath them, so the two rows of numbers disagreed.
 *
 * Every number here comes from `summarise` and `followUpList`, i.e. from the same domain
 * functions the Work list and the Reports page use.
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

  const live = useMemo(() => data.records.filter((r) => r.deletedAt === null), [data.records]);
  const summary = useMemo(
    () => summarise(live, data.categories, { today: data.today }),
    [live, data.categories, data.today],
  );
  const followUp = useMemo(() => followUpList(live, { today: data.today }), [live, data.today]);

  const dueToday = followUp.filter(
    (record) => evaluateDeadline(record, data.today).level === 'due-today',
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

  return (
    <>
      <PageHeader
        title="概览"
        description={`今天是 ${data.today}。`}
        actions={
          <Button
            variant="primary"
            size="lg"
            icon={<Plus size={18} />}
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            新增记录
          </Button>
        }
      />

      {/* A backup warning appears only when acting on it is the right thing to do. */}
      {backupStale ? (
        <Panel tone="warning">
          <div className={styles.banner}>
            <AlertTriangle aria-hidden="true" size={16} />
            <p className={styles.bannerText}>
              {describeBackupHealth(data.backupHealth)} JSON 备份是唯一可完整还原的格式。
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
            数据库中有 {invalidRowCount(data.integrity)}{' '}
            行数据未通过校验，已从列表中排除，未被自动修改；
            在修复之前无法导出完整备份。详情见「设置 → 数据诊断」。
          </p>
        </Panel>
      ) : null}

      <SplitLayout
        main={
          <>
            <div className={styles.metrics}>
              <Metric
                label="需要跟进"
                value={followUp.length}
                detail="逾期、今日到期、7 天内到期与无时限的长期事项"
                emphasis={followUp.length > 0 ? 'alert' : 'normal'}
                onActivate={() => {
                  onNavigate('work');
                }}
                activateLabel="在工作列表中查看需要跟进的事项"
              />
              <Metric
                label="已逾期"
                value={summary.overdue}
                detail={
                  summary.staleBacklog > 0 ? `另有 ${summary.staleBacklog} 条历史遗留` : undefined
                }
                emphasis={summary.overdue > 0 ? 'alert' : 'normal'}
              />
              <Metric label="今日到期" value={dueToday} />
              <Metric label="进行中" value={summary.byStatus['in-progress']} />
              <Metric label="长期推进（未结束）" value={activeLongTerm} />
              <Metric
                label="已完成"
                value={summary.byStatus.completed}
                emphasis="positive"
                detail={`工作记录共 ${summary.workTotal} 条`}
              />
            </div>

            <Card
              title="需要跟进"
              description="按紧迫度排序。逾期超过 30 天的历史遗留不在此处打扰，可在「工作 → 历史遗留」查看。"
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
                <EmptyState title="近期没有逾期或临近到期的事项" />
              ) : (
                <ul className={styles.followList}>
                  {followUp.slice(0, 12).map((record) => (
                    <FollowUpRow key={record.id} record={record} today={data.today} />
                  ))}
                </ul>
              )}
              {summary.staleBacklog > 0 ? (
                <p className={styles.note}>
                  另有 {summary.staleBacklog} 条逾期超过 30 天的历史遗留事项未在此列出。
                </p>
              ) : null}
            </Card>

            {selectedDay !== null ? (
              <Card title={`${selectedDay} 的记录`} headingLevel={3}>
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
              </Card>
            ) : null}
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
