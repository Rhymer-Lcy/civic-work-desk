import type { ReactNode } from 'react';
import { ListTree, Plus, Rows3 } from 'lucide-react';
import { Button, EmptyState } from '@/components/common';
import styles from './WorkPage.module.css';

/**
 * Small pieces of the 工作 page, kept apart from `WorkPage` so that module stays about state and flow.
 */

export type WorkView = 'list' | 'structure';

export function ViewSwitch({
  view,
  onChoose,
}: {
  readonly view: WorkView;
  readonly onChoose: (view: WorkView) => void;
}): ReactNode {
  return (
    <div className={styles.viewSwitch} role="group" aria-label="工作视图">
      <Button
        size="sm"
        variant="secondary"
        icon={<Rows3 size={14} />}
        aria-pressed={view === 'list'}
        onClick={() => {
          onChoose('list');
        }}
      >
        列表
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon={<ListTree size={14} />}
        aria-pressed={view === 'structure'}
        onClick={() => {
          onChoose('structure');
        }}
      >
        任务结构
      </Button>
    </div>
  );
}

/**
 * "Nothing matches" and "nothing exists" are different answers and need different offers (audit
 * E-1). The live count is the discriminator: with records present, the useful action is to relax the
 * filter, not to create another record.
 */
export function WorkEmptyState({
  liveTotal,
  onCreate,
  onClear,
}: {
  readonly liveTotal: number;
  readonly onCreate: () => void;
  readonly onClear: () => void;
}): ReactNode {
  if (liveTotal === 0) {
    return (
      <EmptyState
        title="还没有工作记录"
        description="登记第一条事项后，这里会按时限与状态列出全部工作。"
        action={
          /*
           * Deliberately not labelled 新增记录: that is the shell's action, and two buttons with the
           * same label on one screen is the "several equally prominent actions" problem in miniature.
           * This one names the step instead, and matches the first-run page.
           */
          <Button variant="primary" icon={<Plus size={16} />} onClick={onCreate}>
            新增第一条记录
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      title="没有符合当前筛选条件的记录"
      description={`本机共有 ${String(liveTotal)} 条工作记录，当前筛选条件将它们全部排除了。`}
      action={
        <Button variant="secondary" onClick={onClear}>
          清除全部筛选
        </Button>
      }
    />
  );
}

export function LoadMore({
  visible,
  total,
  unit,
  onMore,
}: {
  readonly visible: number;
  readonly total: number;
  readonly unit: string;
  readonly onMore: () => void;
}): ReactNode {
  if (visible >= total) return null;
  return (
    <div className={styles.more}>
      <Button variant="secondary" onClick={onMore}>
        继续加载（已显示 {visible} / {total}
        {unit}）
      </Button>
    </div>
  );
}
