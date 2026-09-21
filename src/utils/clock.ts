import type { IsoInstant } from '@/domain/types';

/**
 * The single clock seam.
 *
 * Every timestamp and identifier the application writes comes from here, so tests can pin both
 * and assertions never depend on wall-clock time. Production wiring is the platform default.
 */

export interface Clock {
  /** Current instant, ISO 8601 with offset. */
  now(): IsoInstant;
  /** A fresh identifier. */
  id(): string;
}

function platformId(): string {
  // `crypto.randomUUID` is available in every browser this product targets and in Node 24.
  // A guard is kept because jsdom historically lacked it under some configurations.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('crypto.randomUUID is unavailable; cannot mint a stable identifier');
}

const platformClock: Clock = {
  now: () => new Date().toISOString(),
  id: platformId,
};

let active: Clock = platformClock;

export function nowInstant(): IsoInstant {
  return active.now();
}

export function newId(): string {
  return active.id();
}

/** Test-only seam. Returns a restore function. */
export function setClock(clock: Clock): () => void {
  const previous = active;
  active = clock;
  return () => {
    active = previous;
  };
}

/** Format an instant for display in the local timezone, without inventing precision. */
export function formatInstant(instant: IsoInstant): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return instant;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

/** Compact stamp for deterministic, sortable filenames: `YYYYMMDD-HHmmss` in local time. */
export function filenameStamp(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}
