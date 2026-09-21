import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { newId } from '@/utils/clock';
import { ToastContext } from './toast-context';
import type { Toast, ToastApi, ToastTone } from './toast-context';
import styles from './Toast.module.css';

/**
 * Transient status messages.
 *
 * Two rules the legacy `toast()` broke:
 *
 * 1. **A toast is never the only place important information appears.** The legacy toast reported
 *    export counts, import results and errors alike, and vanished after 2.2 s. Here a toast is a
 *    confirmation of something the user just did; anything that must persist (backup health,
 *    import results, storage diagnostics, validation failures) is also rendered in the page.
 *
 * 2. **It is announced.** The region is a polite live region for confirmations and an assertive
 *    one for errors, so a screen-reader user learns that the action completed.
 */

const AUTO_DISMISS_MS = 6_000;

export function ToastProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = newId();
      setToasts((current) => [...current.slice(-2), { id, tone, message }]);
      // Errors persist until dismissed: a failure the user did not read is a failure repeated.
      if (tone !== 'error') {
        timers.current.set(
          id,
          setTimeout(() => {
            dismiss(id);
          }, AUTO_DISMISS_MS),
        );
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={`${styles.region} toast-region`}>
        <div role="status" aria-live="polite" className={styles.stack}>
          {toasts
            .filter((toast) => toast.tone !== 'error')
            .map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
        <div role="alert" aria-live="assertive" className={styles.stack}>
          {toasts
            .filter((toast) => toast.tone === 'error')
            .map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  readonly toast: Toast;
  readonly onDismiss: (id: string) => void;
}): ReactNode {
  return (
    <div className={`${styles.toast} ${styles[toast.tone]}`}>
      <span className={styles.message}>{toast.message}</span>
      <button
        type="button"
        className={styles.close}
        onClick={() => {
          onDismiss(toast.id);
        }}
        aria-label="关闭提示"
      >
        ✕
      </button>
    </div>
  );
}
