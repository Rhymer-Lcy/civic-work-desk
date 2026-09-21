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
 * Collapsed it shows title, status, urgency and two or three identifying facts. Expanded it adds
 * the full detail grid and the progress timeline. The legacy card put the whole action row
 * (进展 / 完成 / 长期 / 编辑 / 删除) on every collapsed card — five buttons per row, with delete
 * beside complete — so the densest thing on screen was the destructive control.
 *
 * Here delete is an icon button *inside* the expanded card with an accessible name and a
 * confirmation, and the collapsed row carries only the disclosure.
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
      className={`${styles.card} ${verdict.level === 'overdue' ? styles.overdue : ''}`}
      aria-labelledby={`work-title-${record.id}`}
    >
      <div className={styles.head}>
        <div className={styles.headMain}>
          <h3 className={styles.title} id={`work-title-${record.id}`}>
            {record.title}
          </h3>
          <div className={styles.badges}>
            <StatusBadge status={record.status} />
            {record.longTerm ? <LongTermBadge /> : null}
            <UrgencyBadge level={verdict.level} text={describeVerdictWithSource(verdict)} />
          </div>
          <dl className={styles.meta}>
            <MetaItem label="日期" value={formatDateValue(record.occurredOn, '未填')} />
            {categoryName ? <MetaItem label="分类" value={categoryName} /> : null}
            {record.counterpartUnit ? (
              <MetaItem label="单位" value={record.counterpartUnit} />
            ) : null}
            {progressCount > 0 ? (
              <div className={styles.metaItem}>
                <dt className={styles.metaLabel}>进展</dt>
                <dd className={styles.metaValue}>
                  <CountBadge value={progressCount} label="进展条数" />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          <ChevronDown
            aria-hidden="true"
            size={18}
            className={expanded ? styles.chevronOpen : undefined}
          />
          <span className="visually-hidden">{expanded ? '收起详情' : '展开详情'}</span>
        </button>
      </div>

      <div className={styles.body} id={panelId} hidden={!expanded}>
        <dl className={styles.detailGrid}>
          <Detail label="完成要求" value={record.requirement} />
          <Detail label="要求上报时限" value={formatDateValue(record.reportDeadline)} />
          <Detail label="完成时限" value={formatDateValue(record.completionDeadline)} />
          <Detail label="完成时间" value={formatDateValue(record.completedOn)} />
          <Detail label="对接人" value={record.counterpartContact} />
          <Detail label="联系方式" value={record.counterpartPhone} />
          <Detail label="归属分组" value={groupName ?? ''} />
          {record.statusLabel && record.statusLabel !== '' ? (
            <Detail label="原始状态文字" value={record.statusLabel} />
          ) : null}
          <Detail label="备注" value={record.remark} wide />
          {record.legacyResidue ? (
            <Detail
              label="迁移保留字段"
              wide
              value={Object.entries(record.legacyResidue)
                .map(([key, value]) => `${key}=${value}`)
                .join('；')}
            />
          ) : null}
        </dl>

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

function MetaItem({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className={styles.metaItem}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>{value}</dd>
    </div>
  );
}

function Detail({
  label,
  value,
  wide = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}): ReactNode {
  if (value.trim() === '') return null;
  return (
    <div className={wide ? `${styles.detail} ${styles.detailWide}` : styles.detail}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{value}</dd>
    </div>
  );
}

export const ADD_PROGRESS_ICON = MessageSquarePlus;
