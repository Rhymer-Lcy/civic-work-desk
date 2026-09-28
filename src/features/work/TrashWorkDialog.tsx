import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { WorkRecord } from '@/domain/types';
import { Button, Dialog } from '@/components/common';

/**
 * Deleting a task that still has live sub-tasks (docs/phase-5-product-evolution.md §5).
 *
 * Nothing happens to a sub-task implicitly, so the choice is the user's and it is spelled out:
 *
 *   - **取消** — the default, and the button that has focus first;
 *   - **下级任务上移一级后删除** — the children move up to this task's own parent, keeping their subtrees,
 *     and only this task goes to the trash;
 *   - **连同下级任务一并移入回收站** — the whole live subtree goes to the trash under one stamp, and
 *     「设置 → 回收站」 can bring exactly that batch back.
 *
 * Both are recoverable, so neither uses the destructive (red) style.
 */

export interface TrashWorkDialogProps {
  readonly record: WorkRecord | null;
  /** Live descendants, at every level. */
  readonly liveDescendants: number;
  /** Live direct children, the ones that would move up. */
  readonly liveChildren: number;
  readonly onTrashSubtree: (record: WorkRecord) => void;
  readonly onPromoteChildren: (record: WorkRecord) => void;
  readonly onCancel: () => void;
}

export function TrashWorkDialog(props: TrashWorkDialogProps): ReactNode {
  if (props.record === null) return null;
  return <TrashWorkDialogBody {...props} record={props.record} />;
}

function TrashWorkDialogBody({
  record,
  liveDescendants,
  liveChildren,
  onTrashSubtree,
  onPromoteChildren,
  onCancel,
}: TrashWorkDialogProps & { readonly record: WorkRecord }): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      title="删除带有下级任务的任务"
      size="md"
      onClose={onCancel}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onPromoteChildren(record);
            }}
          >
            下级任务上移一级后删除
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onTrashSubtree(record);
            }}
          >
            连同 {liveDescendants} 项下级任务一并移入回收站
          </Button>
        </>
      }
    >
      <p>
        「<strong>{record.title}</strong>」下还有 {liveDescendants} 项未删除的下级任务（含各级）。
        不会自动处理它们，请选择：
      </p>
      <ul>
        <li>
          <strong>下级任务上移一级后删除</strong>：{liveChildren}{' '}
          项直接下级连同各自的下级一起上移一级，只把本任务移入回收站。
        </li>
        <li>
          <strong>一并移入回收站</strong>：本任务和全部下级任务一起移入回收站，之后可以在「设置 →
          回收站」一并恢复。
        </li>
      </ul>
    </Dialog>
  );
}
