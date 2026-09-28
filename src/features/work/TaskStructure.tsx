import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, Pencil, Plus } from 'lucide-react';
import { describeVerdictWithSource, evaluateDeadline } from '@/domain/deadlines';
import { MAX_WORK_DEPTH, WORK_LEVEL_LABELS_ZH } from '@/domain/hierarchy';
import {
  childProgress,
  describeChildProgress,
  descendantDeadlines,
} from '@/domain/hierarchy-summary';
import type { StructureNode, WorkIndex } from '@/domain/hierarchy-summary';
import type { WorkRecord } from '@/domain/types';
import { Button, StatusBadge, UrgencyBadge } from '@/components/common';
import styles from './TaskStructure.module.css';

/**
 * 任务结构 — the work hierarchy as an indented outline.
 *
 * **Nested semantic lists, not `role="tree"`.** A real ARIA tree needs the whole keyboard model — roving
 * tabindex, arrow keys, type-ahead — and a partial one is worse than honest lists: screen readers
 * announce "list, 3 items, level 2" for nested `ul`s without any ARIA, and every control here is an
 * ordinary button in document order. The level is also written out (1级任务 / 2级子任务 / 3级子任务), so
 * the structure survives without the indentation or the connector lines, which are decoration.
 *
 * **Context rows.** With a filter in force, a matching sub-task is shown under its ancestors even when
 * they did not match. Those ancestors are muted and labelled 「上下文」 in text — never distinguished by
 * colour alone — so a reader can tell what matched from what explains it.
 *
 * Per node: level, status, title, deadline urgency, 「下级任务 2/3 已完成」 and the descendants' overdue
 * count and nearest deadline, then 编辑 / 添加下级任务 / 调整层级. A level-3 node offers no 添加下级任务:
 * there is no fourth level to add.
 */

export interface TaskStructureProps {
  readonly forest: readonly StructureNode[];
  readonly index: WorkIndex;
  readonly today: string;
  readonly filtered: boolean;
  readonly onEdit: (record: WorkRecord) => void;
  readonly onAddChild: (record: WorkRecord) => void;
  readonly onMove: (record: WorkRecord) => void;
}

export function TaskStructure({
  forest,
  index,
  today,
  filtered,
  onEdit,
  onAddChild,
  onMove,
}: TaskStructureProps): ReactNode {
  // Collapsed ids; everything starts expanded, and a filter shows every match regardless.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul className={styles.tree} aria-label="任务结构">
      {forest.map((node) => (
        <StructureItem
          key={node.record.id}
          node={node}
          index={index}
          today={today}
          collapsed={filtered ? null : collapsed}
          onToggle={toggle}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onMove={onMove}
        />
      ))}
    </ul>
  );
}

interface ItemProps {
  readonly node: StructureNode;
  readonly index: WorkIndex;
  readonly today: string;
  /** Null while a filter is in force: every node is shown expanded. */
  readonly collapsed: ReadonlySet<string> | null;
  readonly onToggle: (id: string) => void;
  readonly onEdit: (record: WorkRecord) => void;
  readonly onAddChild: (record: WorkRecord) => void;
  readonly onMove: (record: WorkRecord) => void;
}

function StructureItem({
  node,
  index,
  today,
  collapsed,
  onToggle,
  onEdit,
  onAddChild,
  onMove,
}: ItemProps): ReactNode {
  const { record, level, context, parentInTrash, children } = node;
  const hasChildren = children.length > 0;
  const expanded = !hasChildren || !(collapsed?.has(record.id) ?? false);
  const childrenId = `structure-children-${record.id}`;
  const titleId = `structure-title-${record.id}`;
  const verdict = evaluateDeadline(record, today);
  const progress = describeChildProgress(childProgress(index, record.id));
  const below = descendantDeadlines(index, record.id, today);
  const levelLabel = level === null ? '层级异常' : WORK_LEVEL_LABELS_ZH[level];
  const canAddChild = level !== null && level < MAX_WORK_DEPTH;

  return (
    <li className={styles.item}>
      <div
        className={`${styles.node} ${context ? styles.context : ''} ${
          verdict.level === 'overdue' ? styles.overdue : ''
        }`}
        aria-labelledby={titleId}
        role="group"
      >
        {hasChildren ? (
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={expanded}
            aria-controls={childrenId}
            aria-label={`${expanded ? '收起' : '展开'}下级任务：${record.title}`}
            onClick={() => {
              onToggle(record.id);
            }}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" size={16} />
            ) : (
              <ChevronRight aria-hidden="true" size={16} />
            )}
          </button>
        ) : (
          <span className={styles.disclosureSpacer} aria-hidden="true" />
        )}

        <span className={styles.level} data-level={level ?? 'unknown'}>
          {levelLabel}
        </span>
        <StatusBadge status={record.status} />
        <span className={styles.title} id={titleId}>
          {record.title}
        </span>
        {context ? <span className={styles.contextTag}>上下文（未匹配筛选）</span> : null}
        <UrgencyBadge level={verdict.level} text={describeVerdictWithSource(verdict)} />

        <NodeMeta progress={progress} below={below} parentInTrash={parentInTrash} />

        <span className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil size={14} />}
            aria-label={`编辑：${record.title}`}
            onClick={() => {
              onEdit(record);
            }}
          >
            编辑
          </Button>
          {canAddChild ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={14} />}
              aria-label={`添加下级任务：${record.title}`}
              onClick={() => {
                onAddChild(record);
              }}
            >
              添加下级任务
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`调整层级：${record.title}`}
            onClick={() => {
              onMove(record);
            }}
          >
            调整层级
          </Button>
        </span>
      </div>

      {/*
       * Rendered even when collapsed, with `hidden`, so the disclosure button's `aria-controls` always
       * names an element that exists.
       */}
      {hasChildren ? (
        <ul className={styles.children} id={childrenId} hidden={!expanded}>
          {children.map((child) => (
            <StructureItem
              key={child.record.id}
              node={child}
              index={index}
              today={today}
              collapsed={collapsed}
              onToggle={onToggle}
              onEdit={onEdit}
              onAddChild={onAddChild}
              onMove={onMove}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NodeMeta({
  progress,
  below,
  parentInTrash,
}: {
  readonly progress: string | null;
  readonly below: ReturnType<typeof descendantDeadlines>;
  readonly parentInTrash: WorkRecord | null;
}): ReactNode {
  return (
    <span className={styles.meta}>
      {progress ? <span>{progress}</span> : null}
      {below.overdue > 0 ? (
        <span className={styles.metaAlert}>下级已逾期 {below.overdue} 项</span>
      ) : null}
      {below.nearest ? (
        <span>
          最近下级时限 {below.nearest.day}（{below.nearest.title}）
        </span>
      ) : null}
      {parentInTrash ? (
        <span className={styles.metaNote}>
          <CornerDownRight aria-hidden="true" size={12} /> 上级任务「{parentInTrash.title}
          」在回收站中
        </span>
      ) : null}
    </span>
  );
}
