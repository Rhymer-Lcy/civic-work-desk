import { createContext, useContext } from 'react';

/**
 * Toast context and consumer hook.
 *
 * Separate from `Toast.tsx` so that file exports only a component; see data-context.tsx for the
 * same reasoning.
 */

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly message: string;
}

export interface ToastApi {
  readonly show: (message: string, tone?: ToastTone) => void;
  readonly dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
