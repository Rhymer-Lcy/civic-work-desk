import { CivicWorkDeskDatabase, DATABASE_NAME } from './schema';
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
