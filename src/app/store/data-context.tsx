import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DataContext, loadSnapshot } from './data-store';
import type { DataContextValue, LoadState } from './data-store';

/**
 * The provider component.
 *
 * Kept in its own module so this file exports only a component — React Fast Refresh cannot
 * preserve state across edits of a module that also exports hooks or plain values. The context
 * object, the snapshot types and the consumer hooks live in `./data-store`.
 */
export function DataProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const data = await loadSnapshot();
      setState({ status: 'ready', data });
    } catch (cause) {
      setState({
        status: 'error',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  }, []);

  useEffect(() => {
    // Scheduled rather than called synchronously: `refresh()` sets state, and doing that in the
    // effect body would commit a second render pass before the first paint.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const value = useMemo<DataContextValue>(() => ({ state, refresh }), [state, refresh]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
