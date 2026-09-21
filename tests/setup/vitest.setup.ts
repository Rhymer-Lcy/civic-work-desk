import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setClock } from '@/utils/clock';

/**
 * Test environment setup.
 *
 * `fake-indexeddb/auto` installs an in-memory IndexedDB so integration tests exercise the real
 * Dexie code paths — transactions, schema versions, key constraints — rather than a hand-written
 * stub that cannot reproduce them.
 *
 * The clock is pinned by default so no assertion depends on wall-clock time. A test that needs a
 * particular date calls `setClock` itself.
 */

let restoreClock: (() => void) | null = null;
let counter = 0;

beforeEach(() => {
  counter = 0;
  restoreClock = setClock({
    now: () => '2026-09-21T09:00:00.000Z',
    id: () => {
      counter += 1;
      return `test-id-${String(counter).padStart(4, '0')}`;
    },
  });
});

afterEach(() => {
  cleanup();
  restoreClock?.();
  restoreClock = null;
});

// jsdom does not implement these; several components probe them.
if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      setTimeout(() => {
        callback(performance.now());
      }, 0) as unknown as number;
    window.cancelAnimationFrame = (handle: number): void => {
      clearTimeout(handle);
    };
  }
}
