import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useMediaQuery, usePrinting } from '@/app/use-media-query';

/**
 * `useMediaQuery` and `usePrinting` decide which ledger presentation exists at all, so their contract
 * is pinned here: the first render is already right, changes are followed, listeners do not leak,
 * and a print commits its DOM before the print layout is taken.
 *
 * jsdom has no `matchMedia`, so a small controllable one stands in for it.
 */

interface FakeList {
  matches: boolean;
  readonly listeners: Set<() => void>;
}

const lists = new Map<string, FakeList>();

function list(query: string): FakeList {
  let found = lists.get(query);
  if (!found) {
    found = { matches: false, listeners: new Set() };
    lists.set(query, found);
  }
  return found;
}

function installMatchMedia(initial: Record<string, boolean>): void {
  for (const [query, matches] of Object.entries(initial)) list(query).matches = matches;
  window.matchMedia = (query: string): MediaQueryList => {
    const state = list(query);
    return {
      media: query,
      get matches() {
        return state.matches;
      },
      addEventListener: (_type: string, listener: () => void) => {
        state.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        state.listeners.delete(listener);
      },
    } as unknown as MediaQueryList;
  };
}

function setMatches(query: string, matches: boolean): void {
  const state = list(query);
  state.matches = matches;
  for (const listener of [...state.listeners]) listener();
}

afterEach(() => {
  // The print flag is module state; a test that failed between the two events must not leak it.
  window.dispatchEvent(new Event('afterprint'));
  lists.clear();
  Reflect.deleteProperty(window, 'matchMedia');
});

const WIDE = '(min-width: 60rem)';

function WidthProbe({ query, renders }: { query: string; renders: string[] }): React.ReactNode {
  const wide = useMediaQuery(query, true);
  renders.push(wide ? 'wide' : 'narrow');
  return <p>{wide ? 'wide' : 'narrow'}</p>;
}

function PrintProbe(): React.ReactNode {
  return <p>{usePrinting() ? 'printing' : 'screen'}</p>;
}

describe('useMediaQuery', () => {
  it('renders the matching state first, with no render in the other state', () => {
    installMatchMedia({ [WIDE]: false });
    const renders: string[] = [];
    render(<WidthProbe query={WIDE} renders={renders} />);
    expect(screen.getByText('narrow')).toBeInTheDocument();
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every((state) => state === 'narrow')).toBe(true);
  });

  it('follows the query across a breakpoint change in both directions', () => {
    installMatchMedia({ [WIDE]: true });
    render(<WidthProbe query={WIDE} renders={[]} />);
    expect(screen.getByText('wide')).toBeInTheDocument();
    act(() => {
      setMatches(WIDE, false);
    });
    expect(screen.getByText('narrow')).toBeInTheDocument();
    act(() => {
      setMatches(WIDE, true);
    });
    expect(screen.getByText('wide')).toBeInTheDocument();
  });

  it('removes its listener on unmount and when the query changes', () => {
    installMatchMedia({ [WIDE]: true, '(min-width: 40rem)': false });
    const view = render(<WidthProbe query={WIDE} renders={[]} />);
    expect(list(WIDE).listeners.size).toBe(1);

    view.rerender(<WidthProbe query="(min-width: 40rem)" renders={[]} />);
    expect(list(WIDE).listeners.size).toBe(0);
    expect(list('(min-width: 40rem)').listeners.size).toBe(1);
    expect(screen.getByText('narrow')).toBeInTheDocument();

    view.unmount();
    expect(list('(min-width: 40rem)').listeners.size).toBe(0);
  });

  it('returns the fallback where matchMedia does not exist', () => {
    expect(typeof window.matchMedia).toBe('undefined');
    render(<WidthProbe query={WIDE} renders={[]} />);
    expect(screen.getByText('wide')).toBeInTheDocument();
  });
});

describe('usePrinting', () => {
  it('commits the print state synchronously inside beforeprint, and reverts after', () => {
    installMatchMedia({ print: false });
    render(<PrintProbe />);
    expect(screen.getByText('screen')).toBeInTheDocument();

    /*
     * Deliberately outside act(): act flushes on exit and would hide a missing flushSync. The DOM
     * must already say "printing" on the line after the event, because that is when a browser takes
     * its print layout.
     */
    const flag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
    const previous = flag.IS_REACT_ACT_ENVIRONMENT;
    flag.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      window.dispatchEvent(new Event('beforeprint'));
      expect(document.body.textContent).toContain('printing');
    } finally {
      flag.IS_REACT_ACT_ENVIRONMENT = previous;
    }

    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(screen.getByText('screen')).toBeInTheDocument();
  });

  it('also follows print media emulation, which fires no print events', () => {
    installMatchMedia({ print: false });
    render(<PrintProbe />);
    act(() => {
      setMatches('print', true);
    });
    expect(screen.getByText('printing')).toBeInTheDocument();
    act(() => {
      setMatches('print', false);
    });
    expect(screen.getByText('screen')).toBeInTheDocument();
  });

  it('leaves no print listener behind after unmount', () => {
    installMatchMedia({ print: false });
    const view = render(<PrintProbe />);
    expect(list('print').listeners.size).toBe(1);
    view.unmount();
    expect(list('print').listeners.size).toBe(0);
  });
});
