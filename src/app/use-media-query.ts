import { useCallback, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/**
 * Whether a CSS media query matches, kept current as the viewport changes.
 *
 * `useSyncExternalStore` reads `matches` synchronously during render, so the first render already has
 * the right answer: nothing is rendered in the wrong mode and then corrected, and in particular a
 * component that chooses between two large presentations never builds both to find out which one it
 * needs. React unsubscribes when the component unmounts or the query changes.
 *
 * This is a client-only application — no server rendering, so no server snapshot and no hydration
 * mismatch to reconcile. Where `matchMedia` does not exist (jsdom, a few embedded web views) the hook
 * returns `fallback` and never subscribes.
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(
    (): boolean =>
      typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback,
    [query, fallback],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Set between `beforeprint` and `afterprint`; shared, because there is one print at a time. */
let printEventsActive = false;

function subscribePrint(onChange: () => void): () => void {
  /*
   * The browser takes its print layout right after `beforeprint` returns, so the update is flushed
   * synchronously inside the handler: a component that renders differently for print has committed
   * that DOM before the layout is taken. Without the flush the page could be printed in its screen
   * form — for the ledger at phone width, as a card list the print stylesheet was never written for.
   */
  const before = (): void => {
    printEventsActive = true;
    flushSync(onChange);
  };
  const after = (): void => {
    printEventsActive = false;
    onChange();
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
  // `print` media also changes under print emulation, which fires no print events.
  const list = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
  list?.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
    list?.removeEventListener('change', onChange);
  };
}

function getPrintSnapshot(): boolean {
  if (printEventsActive) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('print').matches;
}

/** Whether the page is currently being printed (or print media is being emulated). */
export function usePrinting(): boolean {
  return useSyncExternalStore(subscribePrint, getPrintSnapshot);
}
