/**
 * A stored row that failed its schema, kept verbatim.
 *
 * Shared by every store rather than defined per repository, because Phase 1.1 only closed the
 * silent-omission defect for records and progress entries: `listCategories()` and `listGroups()`
 * filtered failing rows out with `.filter(r => r.success)`, and `getSettings()` returned
 * `defaultSettings()` when the stored row did not validate. A "complete canonical backup" could
 * therefore still omit corrupt taxonomy, or replace the user's settings with defaults, without
 * saying so anywhere.
 *
 * The raw value is carried because a canonical backup cannot contain an invalid row — it would not
 * validate on restore — so the raw value is the only evidence that survives, and the diagnostic
 * recovery export exists to preserve it.
 */
export interface InvalidRow {
  /** The row's own id where it has one; a stable synthetic label for singleton stores. */
  readonly id: string;
  readonly reason: string;
  readonly raw: unknown;
}

/** Stable ids for the singleton stores, so an invalid settings row can be named in a list. */
export const SETTINGS_ROW_ID = 'settings:app';

export type ParseOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface Partitioned<T> {
  readonly valid: T[];
  readonly invalid: InvalidRow[];
}

/**
 * Split raw rows into the ones that validate and the ones that do not.
 *
 * Neither side is discarded. The caller decides what a valid row is used for and what an invalid
 * one blocks; this function's only job is to make sure corruption remains observable.
 */
export function partitionRows<T>(
  rows: readonly unknown[],
  parse: (row: unknown) => ParseOutcome<T>,
): Partitioned<T> {
  const valid: T[] = [];
  const invalid: InvalidRow[] = [];
  for (const row of rows) {
    const outcome = parse(row);
    if (outcome.ok) valid.push(outcome.value);
    else invalid.push({ id: readId(row), reason: outcome.reason, raw: row });
  }
  return { valid, invalid };
}

function readId(row: unknown): string {
  if (row !== null && typeof row === 'object') {
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id !== '') return id;
  }
  return '(unknown id)';
}
