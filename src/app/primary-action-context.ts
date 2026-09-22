import { createContext, useContext, useEffect } from 'react';

/**
 * The application's single primary action — context and hooks.
 *
 * Split from the provider component so that file exports only a component: React Fast Refresh can
 * only preserve state across edits when a module's exports are all components, and a mixed module
 * silently degrades to a full reload during development.
 */

export interface PrimaryAction {
  readonly label: string;
  readonly onActivate: () => void;
}

export interface PrimaryActionStore {
  readonly action: PrimaryAction | null;
  readonly setAction: (action: PrimaryAction | null) => void;
}

export const PrimaryActionContext = createContext<PrimaryActionStore | null>(null);

/**
 * Register this view's primary action for as long as it is mounted.
 *
 * Unmounting clears it, which is what makes a view with no creation semantics (台账 / 报告 / 设置)
 * show no button rather than the previous view's.
 */
export function usePrimaryAction(label: string | null, onActivate: () => void): void {
  const store = useContext(PrimaryActionContext);
  useEffect(() => {
    if (!store) return undefined;
    if (label === null) {
      store.setAction(null);
      return undefined;
    }
    store.setAction({ label, onActivate });
    return () => {
      store.setAction(null);
    };
  }, [store, label, onActivate]);
}

/** The currently registered action, for the shell. */
export function useCurrentPrimaryAction(): PrimaryAction | null {
  return useContext(PrimaryActionContext)?.action ?? null;
}
