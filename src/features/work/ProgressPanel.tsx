import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { formatDateValue } from '@/domain/dates';
import type { ProgressEntry } from '@/domain/types';
import { formatInstant } from '@/utils/clock';
import { Button, ConfirmDialog } from '@/components/common';
import styles from './ProgressPanel.module.css';

/**
 * Progress timeline for one record.
 *
 * Entries are addressed by their own id. The legacy implementation addressed them by array index
 * — `editProgress(idx)`, `deleteProgress(idx)` — with the index baked into an inline `onclick`
 * string, so deleting entry 0 renumbered every later entry and a pending edit then wrote to the
 * wrong note. There were also two parallel implementations of the same six functions (a modal
 * pair and a card pair) that could disagree about which entry was being edited.
 */

export interface ProgressPanelProps {
  readonly recordId: string;
  readonly entries: readonly ProgressEntry[];
  readonly onAdd: (recordId: string, note: string) => Promise<void>;
  readonly onEdit: (id: string, note: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

export function ProgressPanel({
  recordId,
  entries,
  onAdd,
  onEdit,
  onDelete,
}: ProgressPanelProps): ReactNode {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ProgressEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const addId = useId();

  const submitNew = async (): Promise<void> => {
    const note = draft.trim();
    if (note === '') return;
    setBusy(true);
    try {
      await onAdd(recordId, note);
      setDraft('');
    } catch {
      // The action hook has already surfaced the failure as an error toast.
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (): Promise<void> => {
    if (editingId === null) return;
    const note = editingText.trim();
    if (note === '') return;
    setBusy(true);
    try {
      await onEdit(editingId, note);
      setEditingId(null);
    } catch {
      /* surfaced by the action hook */
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-label="进展记录">
      <h4 className={styles.heading}>进展记录</h4>

      {entries.length === 0 ? (
        <p className={styles.empty}>暂无进展记录。</p>
      ) : (
        <ol className={styles.timeline}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.itemTime}>
                  {entry.occurredOn.kind === 'absent'
                    ? formatInstant(entry.createdAt)
                    : formatDateValue(entry.occurredOn)}
                </span>
                <div className={styles.itemActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Pencil size={14} />}
                    aria-label={`编辑进展：${entry.note.slice(0, 20)}`}
                    disabled={busy}
                    onClick={() => {
                      setEditingId(entry.id);
                      setEditingText(entry.note);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 size={14} />}
                    aria-label={`删除进展：${entry.note.slice(0, 20)}`}
                    disabled={busy}
                    onClick={() => {
                      setPendingDelete(entry);
                    }}
                  />
                </div>
              </div>

              {editingId === entry.id ? (
                <div className={styles.editor}>
                  <label className="visually-hidden" htmlFor={`edit-${entry.id}`}>
                    编辑进展内容
                  </label>
                  <textarea
                    id={`edit-${entry.id}`}
                    className={styles.textarea}
                    rows={3}
                    value={editingText}
                    onChange={(event) => {
                      setEditingText(event.target.value);
                    }}
                  />
                  <div className={styles.editorActions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<X size={14} />}
                      onClick={() => {
                        setEditingId(null);
                      }}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Check size={14} />}
                      busy={busy}
                      disabled={editingText.trim() === ''}
                      onClick={() => void submitEdit()}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              ) : (
                <p className={styles.itemNote}>{entry.note}</p>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className={styles.add}>
        <label className={styles.addLabel} htmlFor={addId}>
          追加进展
        </label>
        <textarea
          id={addId}
          className={styles.textarea}
          rows={2}
          value={draft}
          placeholder="如：已联系相关单位收集材料，初稿完成。"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={draft.trim() === ''}
          onClick={() => void submitNew()}
        >
          追加
        </Button>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这条进展？"
        body={
          <>
            将删除进展：<strong>{pendingDelete?.note.slice(0, 60) ?? ''}</strong>
            。进展记录不进回收站，删除后无法恢复。
          </>
        }
        confirmLabel="删除"
        busy={busy}
        onCancel={() => {
          setPendingDelete(null);
        }}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          setPendingDelete(null);
          setBusy(true);
          void onDelete(target.id)
            .catch(() => undefined)
            .finally(() => {
              setBusy(false);
            });
        }}
      />
    </section>
  );
}
