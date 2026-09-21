import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import styles from './ConfirmDialog.module.css';

/**
 * Destructive-action confirmation.
 *
 * Two levels, because not all destruction is equal:
 *
 *   - `standard`: a named consequence plus an explicit confirm button. Used for deleting one
 *     record (which is recoverable from the trash) or removing a category.
 *   - `typed`: the user must type a required phrase before the confirm button enables. Used for
 *     replace-mode restore, emptying the trash, and clearing all data — operations the legacy
 *     prototype guarded with exactly the same one-click dialog it used for everything else, so
 *     "清空全部数据" and "删除这条记录" were the same gesture.
 *
 * The confirm button is never the initially focused control, so Enter cannot complete a
 * destructive action by reflex.
 */

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** Phrase the user must type. When present the dialog uses the typed level. */
  readonly requirePhrase?: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The body is mounted only while the dialog is open, so its typed-phrase state starts empty on
 * every open. Resetting it from an effect instead would fire a second render pass on each open and
 * leave a window in which a stale phrase already satisfies the guard.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = '取消',
  requirePhrase,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const phraseInputId = useId();

  const phraseSatisfied = requirePhrase === undefined || typed.trim() === requirePhrase;

  return (
    <Dialog
      open={open}
      title={title}
      size="sm"
      busy={busy}
      onClose={onCancel}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm} busy={busy} disabled={!phraseSatisfied}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.body}>{body}</div>
      {requirePhrase !== undefined ? (
        <div className={styles.phrase}>
          <label className={styles.phraseLabel} htmlFor={phraseInputId}>
            请输入 <code className={styles.code}>{requirePhrase}</code> 以确认
          </label>
          <input
            id={phraseInputId}
            className={styles.phraseInput}
            type="text"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
            aria-describedby={`${phraseInputId}-help`}
          />
          <p className={styles.phraseHelp} id={`${phraseInputId}-help`}>
            {phraseSatisfied ? '已匹配，可以继续。' : '输入完全一致后「确认」按钮才会启用。'}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
