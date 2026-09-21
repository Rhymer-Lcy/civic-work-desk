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

/*
 * jsdom implements neither `URL.createObjectURL` nor a real download, so the final step of an
 * export — hand the blob to the browser — cannot run. Stubbing it lets an integration test exercise
 * the **whole** `createBackup()` path including the bookkeeping that follows the download, which is
 * where the freshness invariants live. Without this a test can only reach the code that throws
 * before the download, and the interesting half never executes.
 *
 * The stubs record nothing: tests assert on the database, not on the stub.
 */
if (typeof URL !== 'undefined') {
  URL.createObjectURL = (): string => 'blob:civic-work-desk-test';
  URL.revokeObjectURL = (): void => undefined;
}
if (typeof HTMLAnchorElement !== 'undefined') {
  HTMLAnchorElement.prototype.click = function click(): void {
    // A real navigation is neither possible nor desirable in jsdom.
  };
}

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
