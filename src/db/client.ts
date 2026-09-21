import { CivicWorkDeskDatabase, DATABASE_NAME, META_KEY } from './schema';
import { ensureSeedData } from './migrations';

/**
 * Database handle.
 *
 * A module-level singleton, opened lazily and seeded exactly once per process. Tests create
 * their own instance with a unique name via `createDatabase` so they never share state.
 */

let singleton: CivicWorkDeskDatabase | null = null;
let readiness: Promise<CivicWorkDeskDatabase> | null = null;

export function createDatabase(name: string = DATABASE_NAME): CivicWorkDeskDatabase {
  return new CivicWorkDeskDatabase(name);
}

/** Open (if needed), apply seeding, and return the shared handle. */
export function getDatabase(): Promise<CivicWorkDeskDatabase> {
  readiness ??= (async () => {
    const db = createDatabase();
    await db.open();
    await ensureSeedData(db);
    singleton = db;
    return db;
  })();
  return readiness;
}

/** Test-only: point the singleton at a prepared instance. */
export function setDatabase(db: CivicWorkDeskDatabase | null): void {
  singleton = db;
  readiness = db ? Promise.resolve(db) : null;
}

export function peekDatabase(): CivicWorkDeskDatabase | null {
  return singleton;
}

/**
 * A database error surfaced to the user rather than swallowed. The legacy prototype wrapped its
 * storage reads in `try { ... } catch(e) { console.error(e) }` and carried on with an empty or
 * partial dataset, so a quota failure looked like data loss.
 */
export class DatabaseError extends Error {
  override readonly name = 'DatabaseError';
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    // The cause's own message is carried into the wrapper text, not just into `cause`. A
    // repository throws domain-meaningful errors ("category already exists", "refusing to write
    // an invalid record"), and those are exactly what the toast shows the user; a wrapper that
    // reported only "operation failed: addCategory" would turn every actionable message into an
    // opaque one.
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${operation} failed: ${detail}`, { cause });
    this.operation = operation;
  }
}

export async function withDatabase<T>(
  operation: string,
  fn: (db: CivicWorkDeskDatabase) => Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  try {
    return await fn(db);
  } catch (cause) {
    throw new DatabaseError(operation, cause);
  }
}

/** The tables a mutation may touch, named so call sites read as a declaration of scope. */
export type MutableTable = 'records' | 'progressEntries' | 'categories' | 'groups' | 'settings';

/**
 * Run a user-data mutation and bump `meta.dataRevision` in the **same** transaction.
 *
 * The invariant this exists to make structural: *any successfully persisted user-data mutation
 * marks the canonical backup stale*. Leaving that to each call site would mean one forgotten
 * `bump()` silently reports a stale backup as current — exactly the class of defect Phase 1 had
 * when it judged freshness by record count alone.
 *
 * Because the counter is written inside the caller's transaction, a rolled-back mutation also
 * rolls back the revision: the two can never disagree.
 */
export async function withMutation<T>(
  operation: string,
  tables: readonly MutableTable[],
  fn: (db: CivicWorkDeskDatabase) => Promise<T>,
): Promise<T> {
  return withDatabase(operation, (db) => {
    const scope = [...tables.map((name) => db[name]), db.meta];
    return db.transaction('rw', scope, async () => {
      const result = await fn(db);
      await bumpDataRevision(db);
      return result;
    });
  });
}

/** Increment the revision counter. Must be called inside a transaction that includes `meta`. */
export async function bumpDataRevision(db: CivicWorkDeskDatabase): Promise<void> {
  const row = await db.meta.get(META_KEY);
  if (!row) return;
  await db.meta.put({
    key: META_KEY,
    value: { ...row.value, dataRevision: row.value.dataRevision + 1 },
  });
}
