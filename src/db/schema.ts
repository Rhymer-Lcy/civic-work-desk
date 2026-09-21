import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import type {
  AnyRecord,
  AppMeta,
  AppSettings,
  BusinessCategory,
  ProgressEntry,
  WorkGroup,
} from '@/domain/types';

/**
 * IndexedDB schema.
 *
 * The legacy prototype used `localStorage` as its database: the entire record array was
 * `JSON.stringify`d into `gov_work_log_v2` on every mutation. That is synchronous, quota-capped
 * at a few megabytes, has no transactions, and silently truncates when the quota is reached.
 *
 * Indexing policy — deliberate and narrow. Only fields used for identity, lifecycle and
 * referential lookups are indexed. Filtering, searching and sorting happen in the domain query
 * engine over an in-memory snapshot, because:
 *   - `DateValue` is a tagged union, so a dotted index path such as `occurredOn.date` is absent
 *     on `text` and `absent` values; Dexie omits those rows from the index, which would make an
 *     indexed date query silently miss exactly the records the date model exists to preserve;
 *   - a single filter implementation is a hard requirement (see docs/legacy-audit.md — the
 *     prototype's two divergent filter paths were a real defect);
 *   - the working set is a personal work log (hundreds to low thousands of rows), where an
 *     in-memory pass is well under a frame.
 * If the working set ever outgrows that, the fix is a denormalised `anchorDay` index column
 * maintained by the repositories, not a second filter implementation.
 */

export const DATABASE_NAME = 'civic-work-desk';

/** Bumped only alongside a migration in `./migrations`. */
export const SCHEMA_VERSION = 1;

/** Singleton row keys. */
export const SETTINGS_KEY = 'app';
export const META_KEY = 'app';

export interface SettingsRow {
  readonly key: string;
  readonly value: AppSettings;
}

export interface MetaRow {
  readonly key: string;
  readonly value: AppMeta;
}

export class CivicWorkDeskDatabase extends Dexie {
  declare records: EntityTable<AnyRecord, 'id'>;
  declare progressEntries: EntityTable<ProgressEntry, 'id'>;
  declare categories: EntityTable<BusinessCategory, 'id'>;
  declare groups: EntityTable<WorkGroup, 'id'>;
  declare settings: EntityTable<SettingsRow, 'key'>;
  declare meta: EntityTable<MetaRow, 'key'>;

  constructor(name: string = DATABASE_NAME) {
    super(name);
    applyVersions(this);
  }
}

/**
 * Version declarations live in one function so the migration list is readable as history.
 * Never edit a shipped version block; add a new one. See docs/migration.md.
 */
export function applyVersions(db: Dexie): void {
  // v1 — initial schema.
  db.version(1).stores({
    records: 'id, kind, deletedAt, updatedAt, categoryId, groupId, status',
    progressEntries: 'id, recordId, createdAt',
    categories: 'id, sortOrder',
    groups: 'id, sortOrder',
    settings: 'key',
    meta: 'key',
  });
}
