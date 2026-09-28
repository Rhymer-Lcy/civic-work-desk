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

/** Bumped only alongside a new `db.version(n)` block below. */
export const SCHEMA_VERSION = 2;

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

  /*
   * v2 — Phase 5, the three-level work hierarchy.
   *
   * `parentWorkId` is indexed because every hierarchy write looks children up by parent inside its
   * transaction. A null key is simply absent from an IndexedDB index, so top-level tasks cost nothing.
   *
   * The upgrade gives every work row that lacks the field `parentWorkId: null` — every pre-Phase-5 task
   * becomes a top-level task — and touches nothing else. Honours, progress, taxonomy, settings and meta
   * are left as they are; a work row that is invalid for some other reason gets the new field and stays
   * exactly as invalid as it was. The migration adds a field, it does not repair, so corruption that was
   * visible in Diagnostics before the upgrade is still visible after it.
   */
  db.version(2)
    .stores({
      records: 'id, kind, deletedAt, updatedAt, categoryId, groupId, status, parentWorkId',
    })
    .upgrade(async (tx) => {
      await tx
        .table('records')
        .toCollection()
        .modify((row: unknown) => {
          if (row === null || typeof row !== 'object') return;
          const record = row as Record<string, unknown>;
          if (record['kind'] !== 'work' || 'parentWorkId' in record) return;
          record['parentWorkId'] = null;
        });
    });
}
