import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { formatDateValue } from '@/domain/dates';
import { describeVerdictWithSource, evaluateDeadline } from '@/domain/deadlines';
import type { BusinessCategory, ProgressEntry, WorkGroup, WorkRecord } from '@/domain/types';
import { Button, CountBadge, LongTermBadge, StatusBadge, UrgencyBadge } from '@/components/common';
import { ProgressPanel } from './ProgressPanel';
import styles from './WorkCard.module.css';

/**
 * A work record in the list.
 *
 * ## Why this stopped being a card
 *
 * The Phase-1 card was ~115 px tall and stacked title, badges and metadata on three lines, so a
 * 1920×1080 screen showed **six** of twenty-four records while roughly half of every row's width sat
 * empty (audit W-1, the phase's only P0). Nothing was aligned, so deadlines could not be compared
 * down a column (W-2), and the only expand affordance was a chevron ~1200 px from the title (W-3).
 *
 * Desktop now renders one **row** per record on a shared column template — status, title, category,
 * counterpart, date, deadline — which fits ~20 records on the same screen and lets the eye run down
 * a column instead of reading each line. Below 72rem the same component falls back to the stacked
 * presentation, because six columns in 390 px is not density, it is a squeeze.
 *
 * The whole row is the disclosure control, so the pointer travel is zero and the target is 1300 px
 * wide rather than 32 px. Edit and delete stay inside the expanded region: a destructive control on
 * every collapsed row is what the Phase-1 rewrite removed on purpose.
 */

export interface WorkCardProps {
  readonly record: WorkRecord;
  readonly today: string;
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly progress: readonly ProgressEntry[];
  readonly progressCount: number;
  readonly onEdit: (record: WorkRecord) => void;
  readonly onDelete: (record: WorkRecord) => void;
  readonly onAddProgress: (recordId: string, note: string) => Promise<void>;
  readonly onEditProgress: (id: string, note: string) => Promise<void>;
  readonly onDeleteProgress: (id: string) => Promise<void>;
}

export function WorkCard({
  record,
  today,
  categories,
  groups,
  progress,
  progressCount,
  onEdit,
  onDelete,
  onAddProgress,
  onEditProgress,
  onDeleteProgress,
}: WorkCardProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const verdict = evaluateDeadline(record, today);
  const categoryName = categories.find((c) => c.id === record.categoryId)?.name;
  const groupName = groups.find((g) => g.id === record.groupId)?.name;
  const panelId = `work-panel-${record.id}`;

  return (
    <article
      className={`${styles.row} ${verdict.level === 'overdue' ? styles.overdue : ''} ${
        expanded ? styles.rowExpanded : ''
      }`}
      aria-labelledby={`work-title-${record.id}`}
    >
      <button
        type="button"
        className={styles.summary}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        <span className={styles.colStatus}>
          <StatusBadge status={record.status} />
        </span>

        <span className={styles.colTitle}>
          <span className={styles.title} id={`work-title-${record.id}`}>
            {record.title}
          </span>
          {record.longTerm ? <LongTermBadge /> : null}
          {progressCount > 0 ? <CountBadge value={progressCount} label="进展条数" /> : null}
        </span>

        <span className={styles.colCategory}>{categoryName ?? ''}</span>
        <span className={styles.colUnit}>{record.counterpartUnit}</span>
        <span className={styles.colDate}>{formatDateValue(record.occurredOn, '')}</span>

        <span className={styles.colVerdict}>
          <UrgencyBadge level={verdict.level} text={describeVerdictWithSource(verdict)} />
        </span>

        <span className={styles.colChevron}>
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={expanded ? styles.chevronOpen : undefined}
          />
          <span className="visually-hidden">{expanded ? '收起详情' : '展开详情'}</span>
        </span>
      </button>

      <div className={styles.body} id={panelId} hidden={!expanded}>
        {/*
         * Grouped rather than flat. Eleven label/value pairs at one weight made the reader parse
         * labels to find anything (audit R-1); three named groups let them land on a region first.
         */}
        <div className={styles.detailGroups}>
          <DetailGroup title="时间节点">
            <Detail label="要求上报时限" value={formatDateValue(record.reportDeadline)} />
            <Detail label="完成时限" value={formatDateValue(record.completionDeadline)} />
            <Detail label="完成时间" value={formatDateValue(record.completedOn)} />
          </DetailGroup>
          <DetailGroup title="对接信息">
            <Detail label="对接单位" value={record.counterpartUnit} />
            <Detail label="对接人" value={record.counterpartContact} />
            <Detail label="联系方式" value={record.counterpartPhone} />
          </DetailGroup>
          <DetailGroup title="归属与分类">
            <Detail label="业务分类" value={categoryName ?? ''} />
            <Detail label="归属分组" value={groupName ?? ''} />
            {record.statusLabel && record.statusLabel !== '' ? (
              <Detail label="原始状态文字" value={record.statusLabel} />
            ) : null}
          </DetailGroup>
        </div>

        <div className={styles.notes}>
          <Detail label="完成要求" value={record.requirement} block />
          <Detail label="备注" value={record.remark} block />
          {record.legacyResidue ? (
            <Detail
              label="迁移保留字段"
              block
              value={Object.entries(record.legacyResidue)
                .map(([key, value]) => `${key}=${value}`)
                .join('；')}
            />
          ) : null}
        </div>

        <ProgressPanel
          recordId={record.id}
          entries={progress}
          onAdd={onAddProgress}
          onEdit={onEditProgress}
          onDelete={onDeleteProgress}
        />

        <div className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            icon={<Pencil size={14} />}
            onClick={() => {
              onEdit(record);
            }}
          >
            编辑
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={() => {
              onDelete(record);
            }}
          >
            删除
          </Button>
        </div>
      </div>
    </article>
  );
}

function DetailGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className={styles.detailGroup}>
      <p className={styles.detailGroupTitle}>{title}</p>
      <dl className={styles.detailList}>{children}</dl>
    </div>
  );
}

function Detail({
  label,
  value,
  block = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly block?: boolean;
}): ReactNode {
  if (value.trim() === '') return null;
  return (
    <div className={block ? styles.detailBlock : styles.detail}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{value}</dd>
    </div>
  );
}

export const ADD_PROGRESS_ICON = MessageSquarePlus;
