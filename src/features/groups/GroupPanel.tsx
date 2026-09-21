import type { ReactNode } from 'react';
import { evaluateDeadline } from '@/domain/deadlines';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord, WorkGroup } from '@/domain/types';
import { Button, Card, CountBadge } from '@/components/common';
import styles from './GroupPanel.module.css';

/**
 * Fixed / long-term / supervised groupings.
 *
 * A read-only summary. The legacy sidebar made this panel an editing surface too: `addGroup()`
 * and `quickAddToGroup()` opened `window.prompt()`, and each group header carried a bare `×` that
 * deleted the group and silently detached every record in it. Group management now lives in
 * Settings, where a deletion can state how many records it affects.
 */

export interface GroupPanelProps {
  readonly records: readonly AnyRecord[];
  readonly groups: readonly WorkGroup[];
  readonly today: string;
  readonly onOpenWork: () => void;
}

export function GroupPanel({ records, groups, today, onOpenWork }: GroupPanelProps): ReactNode {
  const visible = groups.filter((group) => !group.archived);

  return (
    <Card
      title="固定 / 长期 / 分管工作"
      headingLevel={3}
      description="常驻跟进的分组。分组的增删改在「设置」中。"
      actions={
        <Button size="sm" variant="ghost" onClick={onOpenWork}>
          按分组筛选
        </Button>
      }
    >
      {visible.length === 0 ? (
        <p className={styles.empty}>还没有分组。</p>
      ) : (
        <ul className={styles.list}>
          {visible.map((group) => {
            const members = records.filter(
              (record) => isWorkRecord(record) && record.groupId === group.id,
            );
            const open = members.filter(
              (record) =>
                isWorkRecord(record) &&
                record.status !== 'completed' &&
                record.status !== 'cancelled',
            );
            const overdue = open.filter(
              (record) =>
                isWorkRecord(record) && evaluateDeadline(record, today).level === 'overdue',
            ).length;

            return (
              <li key={group.id} className={styles.group}>
                <div className={styles.groupHead}>
                  <span className={styles.groupName}>{group.name}</span>
                  <CountBadge value={members.length} label={`${group.name} 记录数`} />
                </div>
                <p className={styles.groupMeta}>
                  未结束 {open.length} 条{overdue > 0 ? `，其中已逾期 ${overdue} 条` : ''}
                </p>
                {open.length > 0 ? (
                  <ul className={styles.items}>
                    {open.slice(0, 4).map((record) => (
                      <li key={record.id} className={styles.item}>
                        {record.title}
                      </li>
                    ))}
                    {open.length > 4 ? (
                      <li className={styles.itemMore}>还有 {open.length - 4} 条…</li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
