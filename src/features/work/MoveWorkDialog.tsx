import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { eligibleParents, WORK_LEVEL_LABELS_ZH } from '@/domain/hierarchy';
import { describePath, hierarchyContext } from '@/domain/hierarchy-summary';
import type { WorkIndex } from '@/domain/hierarchy-summary';
import { normaliseForSearch } from '@/domain/query';
import { isWorkRecord } from '@/domain/types';
import type { WorkRecord } from '@/domain/types';
import { Button, Dialog, Field, fieldControlClass } from '@/components/common';
import styles from './MoveWorkDialog.module.css';

/**
 * 调整层级 — move a task, with its whole subtree, under another task or to the top level.
 *
 * A dialog with a filterable list rather than drag and drop: every choice is reachable by keyboard and
 * by screen reader, and nothing happens until 确定调整 is pressed. The list offers only targets the
 * repository would accept (`eligibleParents`, the same rule as `canMove`), so an impossible move is not
 * offered in the first place; the repository still checks again, inside its transaction, because
 * another tab may have changed the tree since the list was built.
 */

const TOP_LEVEL = '__top-level__';
/** A native list with thousands of options is unusable; the filter is the way to reach the rest. */
const MAX_OPTIONS = 200;

export interface MoveWorkDialogProps {
  readonly record: WorkRecord | null;
  readonly index: WorkIndex;
  readonly onMove: (id: string, newParentId: string | null) => Promise<void>;
  readonly onClose: () => void;
}

export function MoveWorkDialog(props: MoveWorkDialogProps): ReactNode {
  if (props.record === null) return null;
  return <MoveWorkDialogBody {...props} record={props.record} />;
}

function MoveWorkDialogBody({
  record,
  index,
  onMove,
  onClose,
}: MoveWorkDialogProps & { readonly record: WorkRecord }): ReactNode {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string>(record.parentWorkId ?? TOP_LEVEL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const current = hierarchyContext(index, record.id);
  const candidates = useMemo(
    () =>
      eligibleParents(index, record.id)
        .filter(isWorkRecord)
        .map((candidate) => {
          const context = hierarchyContext(index, candidate.id);
          const level = context.level ?? 1;
          const path = describePath([...context.ancestors, candidate]);
          return { id: candidate.id, label: `${WORK_LEVEL_LABELS_ZH[level]}　${path}`, path };
        })
        .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN')),
    [index, record.id],
  );
  const needle = normaliseForSearch(filter);
  const matching =
    needle === ''
      ? candidates
      : candidates.filter((c) => normaliseForSearch(c.path).includes(needle));
  const shown = matching.slice(0, MAX_OPTIONS);
  const unchanged = selected === (record.parentWorkId ?? TOP_LEVEL);

  const describeCurrent =
    current.level === null
      ? '当前层级无法确定。'
      : current.ancestors.length === 0
        ? `当前为 ${WORK_LEVEL_LABELS_ZH[current.level]}。`
        : `当前为 ${WORK_LEVEL_LABELS_ZH[current.level]}，上级：${describePath(current.ancestors)}。`;

  const confirm = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await onMove(record.id, selected === TOP_LEVEL ? null : selected);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '调整失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      title="调整层级"
      description={`「${record.title}」连同它的全部下级任务一起移动。${describeCurrent}`}
      size="md"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            busy={saving}
            disabled={unchanged}
            onClick={() => void confirm()}
          >
            确定调整
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Field label="查找上级任务" hint="只列出不会超过 3 级、也不会形成循环的任务。">
          {({ id, describedBy }) => (
            <input
              id={id}
              type="search"
              className={fieldControlClass}
              aria-describedby={describedBy}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="新的上级任务" error={error}>
          {({ id, describedBy, invalid }) => (
            <select
              id={id}
              className={`${fieldControlClass} ${styles.list}`}
              size={8}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
              }}
            >
              <option value={TOP_LEVEL}>（无上级）设为 1级任务</option>
              {shown.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className={styles.count} role="status">
          {matching.length > shown.length
            ? `符合条件的任务共 ${String(matching.length)} 项，仅显示前 ${String(MAX_OPTIONS)} 项，请输入关键字缩小范围。`
            : `可选的上级任务 ${String(matching.length)} 项。`}
        </p>
      </div>
    </Dialog>
  );
}
