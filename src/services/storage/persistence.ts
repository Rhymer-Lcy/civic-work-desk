/**
 * Storage durability and UI preferences.
 *
 * Two distinct concerns, both small:
 *
 * 1. **Durability.** Browsers may evict IndexedDB under storage pressure. The Storage API lets us
 *    *ask* for persistence, so we ask — but the product never claims the answer is a guarantee.
 *    Settings shows the actual granted state, usage and quota, so the user can judge rather than
 *    be reassured. `docs/security.md` records that a persisted store is still not a backup.
 *
 * 2. **Preferences.** `localStorage` is used *only* for ephemeral view state (last tab, sort
 *    order). Records never touch it. That inversion is the point: the legacy prototype put the
 *    whole database in `localStorage` and nothing else.
 */

export interface StorageDiagnostics {
  /** Whether the Storage API exists at all in this browser. */
  readonly supported: boolean;
  /** Whether persistence is currently granted. Null when unknown. */
  readonly persisted: boolean | null;
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
}

/**
 * The Storage API as this runtime actually provides it.
 *
 * Typed as possibly-absent on purpose: the DOM lib declares `navigator.storage` as always present,
 * but it is missing in older Safari, in some embedded webviews, and under `file://`. Trusting the
 * type here would mean a TypeError on exactly the platforms the guard exists for.
 */
function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { storage?: StorageManager }).storage;
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  const storage = storageManager();
  if (!storage) return null;
  try {
    if (typeof storage.persisted === 'function') {
      if (await storage.persisted()) return true;
    }
    if (typeof storage.persist === 'function') {
      return await storage.persist();
    }
    return null;
  } catch {
    return null;
  }
}

export async function readStorageDiagnostics(): Promise<StorageDiagnostics> {
  const storage = storageManager();
  if (!storage) {
    return { supported: false, persisted: null, usageBytes: null, quotaBytes: null };
  }
  let persisted: boolean | null = null;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    if (typeof storage.persisted === 'function') {
      persisted = await storage.persisted();
    }
  } catch {
    persisted = null;
  }
  try {
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      usageBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    }
  } catch {
    usageBytes = null;
    quotaBytes = null;
  }
  return { supported: true, persisted, usageBytes, quotaBytes };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/* ------------------------------------------------------- UI preferences only */

const PREF_PREFIX = 'cwd.pref.';

/** `localStorage` throws in some privacy modes and is absent in a few webviews. */
function localStore(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage;
}

/**
 * Only these keys may be persisted. An allow-list rather than a convention, so a future change
 * cannot start writing record content into `localStorage` by accident.
 */
export const PREFERENCE_KEYS = ['lastRoute', 'workSort', 'ledgerSort', 'reportPeriodType'] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export function readPreference(key: PreferenceKey): string | null {
  try {
    return localStore()?.getItem(PREF_PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(key: PreferenceKey, value: string): void {
  try {
    localStore()?.setItem(PREF_PREFIX + key, value);
  } catch {
    // A full or blocked localStorage must never break the app: preferences are cosmetic.
  }
}

/**
 * Remove every key this application owns. Used by "clear local data" so the operation is
 * complete — the legacy `clearAllData()` emptied the record array but left the config, the
 * group list and two migration flags behind, so a "cleared" install still carried state.
 */
export function clearAllPreferences(): void {
  try {
    const store = localStore();
    if (!store) return;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(PREF_PREFIX) === true) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Ignored for the same reason as above.
  }
}
