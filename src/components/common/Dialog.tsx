import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Dialog.module.css';

/**
 * Accessible modal dialog.
 *
 * The legacy prototype's modals were `<div class="modal-mask">` toggled by a CSS class. They had
 * no `role`, no accessible name, no focus trap, no Escape handling, and focus stayed on whatever
 * was behind them — so a keyboard user tabbed straight through the dialog into the page below it.
 *
 * This implementation satisfies WCAG 2.4.3 / 2.1.2:
 *   - `role="dialog"` + `aria-modal` + `aria-labelledby`;
 *   - focus moves to the dialog on open and returns to the invoking element on close;
 *   - Tab and Shift+Tab cycle within the dialog;
 *   - Escape closes, and a backdrop click closes only when the dialog is not "busy";
 *   - background scrolling is locked while open.
 */

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  /** When true the dialog refuses to close from Escape or backdrop (e.g. mid-import). */
  readonly busy?: boolean;
  /** Ref of the control to focus first. Defaults to the dialog container. */
  readonly initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Background scroll lock.
 *
 * A class whose rule lives in `styles/globals.css`, not a `document.body.style.overflow` write.
 *
 * Be precise about why, because the obvious reason is wrong: CSP's `style-src` does **not** govern
 * CSSOM property writes, and a mutation test confirmed it — restoring the `style.overflow` write
 * under `style-src 'self'` raised no violation at all. What the write does produce is an inline
 * `style` attribute on `<body>`, which `style-src-attr` would govern if the policy were ever
 * tightened that far, and which puts presentation in two places at once. The class keeps every
 * declaration in the stylesheet and lets an E2E test assert the plain structural invariant that
 * `<body>` carries no `style` attribute.
 *
 * Reference-counted because dialogs nest: an import preview can open a confirmation on top of
 * itself, and the inner one closing must not release the outer one's lock.
 */
export const SCROLL_LOCK_CLASS = 'dialog-open';
let scrollLocks = 0;

function lockBackgroundScroll(): () => void {
  scrollLocks += 1;
  document.body.classList.add(SCROLL_LOCK_CLASS);
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.classList.remove(SCROLL_LOCK_CLASS);
  };
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  busy = false,
  initialFocusRef,
}: DialogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  // Remember the trigger so focus can be restored exactly where it came from.
  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      restoreRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const target = initialFocusRef?.current ?? panelRef.current;
    // A frame is needed so the element exists and is laid out before focusing.
    const handle = requestAnimationFrame(() => target?.focus());
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    return lockBackgroundScroll();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, requestClose]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      // A backdrop click is a convenience, not the accessible path: Escape and the close button
      // both work, so this presentational div carries no role and no keyboard handler.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        className={`${styles.panel} ${styles[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {/*
            A fixed name rather than `关闭${title}`. Interpolating the title made the close
            button's name a superset of every button name in the dialog body, so an accessible-name
            query for a body action ("移入回收站") also matched the close button. The dialog's own
            accessible name is announced on entry, so "关闭对话框" is unambiguous in context.
          */}
          <button
            type="button"
            className={styles.close}
            onClick={requestClose}
            disabled={busy}
            aria-label="关闭对话框"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        {description ? (
          <p id={descriptionId} className={styles.description}>
            {description}
          </p>
        ) : null}
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  );
}
